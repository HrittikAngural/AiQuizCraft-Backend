import Groq from 'groq-sdk';
import TopicRequest from '../models/TopicRequest.js';
import { quizHistory } from '../utils/cacheUtil.js';

const DEFAULT_FALLBACK_MODELS = [
  'llama-3.1-8b-instant'
];

const KNOWN_GROQ_CHAT_MODELS = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'qwen/qwen3-32b',
  'moonshotai/kimi-k2-instruct',
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant'
];

const MODEL_LIST_TTL_MS = 10 * 60 * 1000;
const MAX_CONCURRENT_GROQ_REQUESTS = 2;
const NON_CHAT_MODEL = /whisper|audio|speech|tts|embedding|embed|guard|moderation|transcription|translation/i;
let modelListCache = { fetchedAt: 0, ids: null };
let modelListRequest;
let activeGroqRequests = 0;
const groqRequestQueue = [];

const withGroqRequestSlot = async (callback) => {
  if (activeGroqRequests >= MAX_CONCURRENT_GROQ_REQUESTS) {
    await new Promise(resolve => groqRequestQueue.push(resolve));
  } else {
    activeGroqRequests += 1;
  }

  try {
    return await callback();
  } finally {
    const nextInQueue = groqRequestQueue.shift();
    if (nextInQueue) nextInQueue();
    else activeGroqRequests -= 1;
  }
};

const runWithConcurrency = async (items, concurrency, worker) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  let firstError;

  const runWorker = async () => {
    while (!firstError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        firstError = error;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker())
  );

  if (firstError) throw firstError;
  return results;
};

const getAvailableModelIds = async (groq) => {
  if (modelListCache.ids && Date.now() - modelListCache.fetchedAt < MODEL_LIST_TTL_MS) {
    return modelListCache.ids;
  }

  if (!modelListRequest) {
    modelListRequest = groq.models.list()
      .then((response) => {
        const ids = (response.data || []).map(model => model.id).filter(Boolean);
        modelListCache = { fetchedAt: Date.now(), ids };
        return ids;
      })
      .finally(() => { modelListRequest = undefined; });
  }

  return modelListRequest;
};

const unique = (items) => {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
};

const isQuotaError = (err) => {
  const msg = (err?.message || '').toLowerCase();
  return err?.status === 429 || msg.includes('quota') || msg.includes('too many requests');
};

const DIFFICULTY_GUIDANCE = {
  easy: 'Every question must test one foundational fact or concept using direct recall or a simple, familiar example. The answer should be apparent after understanding that one concept. Do not require multiple steps, combine concepts, or use edge cases.',
  medium: 'Every question must test understanding or application in a familiar context and require interpretation or one reasoning step. Use plausible distractors. Do not make questions solvable by simple definition recall alone, but avoid multi-step analysis and obscure edge cases.',
  hard: 'Every question must require applying at least two related concepts, completing multiple reasoning steps, or analyzing a meaningful edge case. Use non-obvious scenarios and plausible distractors based on common misconceptions. Do not ask simple definitions, isolated fact recall, or questions solvable with only one straightforward step. Difficulty must come from the reasoning required, not confusing wording or obscure trivia.'
};

// Retry logic for temporary failures
const getRetryAfterMs = (error) => {
  const headerValue = error?.headers?.get?.('retry-after')
    ?? error?.headers?.['retry-after']
    ?? error?.response?.headers?.get?.('retry-after')
    ?? error?.response?.headers?.['retry-after'];

  if (headerValue === undefined || headerValue === null) return 0;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const retryAt = Date.parse(headerValue);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
};

const retryWithBackoff = async (fn, maxRetries = 4, baseDelay = 800) => {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      const status = Number(error?.status);
      const isRetryable =
        status === 429 ||
        status === 498 ||
        status >= 500 ||
        isQuotaError(error) ||
        error.message?.includes('Service Unavailable') ||
        error.message?.includes('temporarily') ||
        error.message?.includes('high demand');
      
      if (!isRetryable || attempt === maxRetries - 1) {
        throw error;
      }
      
      const exponentialDelay = baseDelay * Math.pow(2, attempt);
      const delay = Math.max(exponentialDelay, getRetryAfterMs(error)) + Math.floor(Math.random() * 250);
      console.log(`Attempt ${attempt + 1} failed. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
};

export const generateQuiz = async (req, res) => {
  try {
    if (!process.env.GROQ_API_KEY) {
      throw new Error('Groq API key is not configured in environment variables');
    }

    const { prompt, topic, numQuestions, difficulty } = req.method === 'POST' ? req.body : req.query;
    
    if (!prompt) {
      return res.status(400).json({
        status: 'error',
        message: 'Prompt is required'
      });
    }

    const recentQuestions = topic
      ? quizHistory.getRecentQuestions(topic).slice(-30)
      : [];
    const normalizedDifficulty = String(difficulty || 'medium').trim().toLowerCase();
    if (!Object.hasOwn(DIFFICULTY_GUIDANCE, normalizedDifficulty)) {
      return res.status(400).json({
        status: 'error',
        message: 'Difficulty must be easy, medium, or hard.'
      });
    }
    const difficultyGuidance = DIFFICULTY_GUIDANCE[normalizedDifficulty];
    const requestedQuestionCount = Math.min(100, Math.max(1, Math.ceil(Number(numQuestions) || 10)));
    const batchSize = Math.min(25, requestedQuestionCount);
    const totalBatchCount = Math.ceil(requestedQuestionCount / batchSize);

    const generateBatch = async ({ batchIndex, batchCount, avoidQuestions = [], supplemental = false }) => {
      const outputTokenLimit = Math.min(10000, Math.max(2048, batchCount * 500));
      const batchRecentQuestions = [
        ...recentQuestions,
        ...avoidQuestions
      ].slice(-30);
      const batchPrompt = prompt.replace(
        /^Generate\s+\d+\s+multiple choice questions/i,
        `Generate ${batchCount} multiple choice questions`
      );

      // Split large quizzes into bounded requests and keep every response small enough to validate.
      const generateContent = async () => {
        const groq = new Groq({
          apiKey: process.env.GROQ_API_KEY,
          maxRetries: 0,
          timeout: 90000
        });

        const selectedModel = process.env.GENAI_MODEL || DEFAULT_FALLBACK_MODELS[0];
        const fallbackModels = (process.env.GENAI_FALLBACK_MODELS || DEFAULT_FALLBACK_MODELS.join(','))
          .split(',')
          .map(m => m.trim())
          .filter(Boolean);

        const configuredCandidates = unique([
          selectedModel,
          ...fallbackModels
        ]);

        let candidates = unique([...configuredCandidates, ...KNOWN_GROQ_CHAT_MODELS]);
        try {
          const availableIds = await getAvailableModelIds(groq);
          const availableSet = new Set(availableIds);
          const discoveredChatModels = availableIds.filter(model => !NON_CHAT_MODEL.test(model));
          candidates = unique([...candidates, ...discoveredChatModels])
            .filter(model => availableSet.has(model))
            .slice(0, 5);
          if (!candidates.length) {
            console.error('None of the configured or known Groq chat models are available to this API key.');
          }
        } catch (discoveryError) {
          console.warn('Groq model discovery failed; trying configured model IDs:', discoveryError?.message || discoveryError);
        }

        if (!candidates.length) {
          const err = new Error('No configured Groq chat models are available to this API key.');
          err.status = 502;
          throw err;
        }

        const failures = [];
        let lastError;
        for (const candidateModel of candidates) {
          try {
            const messages = [
              {
                role: 'system',
                content: [
                  'You are an expert educational quiz generator. Output ONLY one valid JSON object in exactly this shape: {"questions":[{"question":"...","options":["...","...","...","..."],"correctAnswer":0,"explanation":"..."}]}. Do not include markdown, extra keys, or text outside the JSON object. correctAnswer must be a zero-based integer index into options. Keep each explanation concise.',
                  `The requested difficulty is ${normalizedDifficulty}. Apply these criteria to every question; do not include questions from an easier tier: ${difficultyGuidance}`,
                  'Keep the requested difficulty consistent across the entire quiz. Make each question independently meet the criteria, rather than relying on difficult vocabulary or a single hard question to set the level.',
                  `Return exactly ${batchCount} questions.`,
                  supplemental
                    ? 'These are replacement questions. Do not repeat any question in the recent-question list.'
                    : `This is batch ${batchIndex + 1} of ${totalBatchCount}. Use a distinct set of concepts and examples, and do not repeat any question in the recent-question list.`,
                  'Every question in this quiz must be distinct and must not repeat any question from the recent-question list. Use different concepts, examples, and wording.',
                  batchRecentQuestions.length ? `Recent questions to avoid: ${JSON.stringify(batchRecentQuestions)}` : ''
                ].filter(Boolean).join('\n')
              },
              {
                role: 'user',
                content: `${batchPrompt}\nGenerate exactly ${batchCount} questions in this response.`
              }
            ];
            let result;
            try {
              result = await withGroqRequestSlot(() => groq.chat.completions.create({
                messages,
                model: candidateModel,
                response_format: { type: 'json_object' },
                temperature: 0.7,
                max_tokens: outputTokenLimit,
              }));
            } catch (requestError) {
              const requestMessage = (requestError?.message || '').toLowerCase();
              const canRetryWithoutJsonMode = requestError?.status === 400 &&
                /json|response_format|max_tokens|unsupported parameter/.test(requestMessage);
              if (!canRetryWithoutJsonMode) throw requestError;

              console.warn(`Retrying ${candidateModel} without JSON-mode options.`);
              result = await withGroqRequestSlot(() => groq.chat.completions.create({
                messages,
                model: candidateModel,
                temperature: 0.7,
                max_tokens: outputTokenLimit
              }));
            }
            return result.choices[0]?.message?.content || '';
          } catch (genErr) {
            lastError = genErr;
            failures.push(`${candidateModel}: ${genErr?.message || genErr}`);

            const msg = (genErr?.message || '').toLowerCase();
            const shouldTryNextModel = isQuotaError(genErr) ||
              msg.includes('not found') ||
              msg.includes('not supported') ||
              genErr?.status === 400 ||
              genErr?.status === 404;

            if (shouldTryNextModel) continue;

            const err = new Error(`${candidateModel}: ${genErr?.message || genErr}`);
            err.status = genErr?.status || genErr?.code || 500;
            throw err;
          }
        }

        console.error('All configured Groq models failed:', failures.join(' | '));
        const err = new Error(lastError?.message || 'All configured Groq models failed');
        err.status = lastError?.status || 502;
        err.code = lastError?.code;
        throw err;
      };

      let batchQuestions;
      let parseError;
      for (let attempt = 0; attempt < 2 && !batchQuestions; attempt += 1) {
        const text = await retryWithBackoff(generateContent);
        try {
          const cleanText = text.replace(/```(?:json)?/gi, '').trim();
          let questions = JSON.parse(cleanText);

          for (let depth = 0; depth < 3 && !Array.isArray(questions); depth += 1) {
            if (typeof questions === 'string') {
              try {
                questions = JSON.parse(questions);
              } catch {
                break;
              }
            } else if (questions && typeof questions === 'object') {
              questions = questions.questions ?? questions.data ?? questions.quiz;
            } else {
              break;
            }
          }

          if (!Array.isArray(questions) || questions.length !== batchCount) {
            throw new Error(`Expected ${batchCount} questions in the AI response.`);
          }

          batchQuestions = questions.map((question) => {
            if (!question || typeof question.question !== 'string' || !Array.isArray(question.options)) {
              throw new Error('A generated question is missing its text or answer options.');
            }

            const rawAnswer = question.correctAnswer ?? question.answer;
            const correctAnswer = typeof rawAnswer === 'number' ? rawAnswer : Number(rawAnswer);
            if (!Number.isInteger(correctAnswer) || correctAnswer < 0 || correctAnswer >= question.options.length) {
              throw new Error('A generated question has an invalid correct-answer index.');
            }

            return { ...question, correctAnswer };
          });
        } catch (error) {
          parseError = error;
        }
      }

      if (!batchQuestions) {
        if (batchCount > 5) {
          const firstHalfCount = Math.ceil(batchCount / 2);
          const splitResults = await runWithConcurrency([
            { batchIndex, batchCount: firstHalfCount, avoidQuestions, supplemental: true },
            { batchIndex: batchIndex + 1, batchCount: batchCount - firstHalfCount, avoidQuestions, supplemental: true }
          ], 2, generateBatch);
          return splitResults.flat();
        }

        const error = new Error('The AI returned an incomplete or invalid quiz response. Please try again.');
        error.status = 502;
        error.cause = parseError;
        console.error(`AI returned invalid quiz JSON for ${supplemental ? 'a supplemental batch' : `batch ${batchIndex + 1}`}:`, parseError?.message);
        throw error;
      }

      return batchQuestions;
    };

    const initialBatchSpecs = Array.from({ length: totalBatchCount }, (_, batchIndex) => ({
      batchIndex,
      batchCount: Math.min(batchSize, requestedQuestionCount - batchIndex * batchSize)
    }));
    const initialBatchResults = await runWithConcurrency(initialBatchSpecs, 2, generateBatch);
    const normalizedQuestionKey = question => String(question || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const seenQuestionKeys = new Set(recentQuestions.map(normalizedQuestionKey).filter(Boolean));
    const validatedQuestions = [];
    const addUniqueQuestions = (questions) => {
      for (const question of questions) {
        const key = normalizedQuestionKey(question.question);
        if (!key || seenQuestionKeys.has(key)) continue;
        seenQuestionKeys.add(key);
        validatedQuestions.push(question);
      }
    };

    initialBatchResults.forEach(addUniqueQuestions);

    for (let repairRound = 0; validatedQuestions.length < requestedQuestionCount && repairRound < 2; repairRound += 1) {
      let missingCount = requestedQuestionCount - validatedQuestions.length;
      const repairSpecs = [];
      while (missingCount > 0) {
        const replacementCount = Math.min(10, missingCount);
        repairSpecs.push({
          batchIndex: totalBatchCount + repairSpecs.length,
          batchCount: replacementCount,
          avoidQuestions: validatedQuestions.map(question => question.question),
          supplemental: true
        });
        missingCount -= replacementCount;
      }

      const repairResults = await runWithConcurrency(repairSpecs, 2, generateBatch);
      repairResults.forEach(addUniqueQuestions);
    }

    if (validatedQuestions.length !== requestedQuestionCount) {
      const error = new Error('The AI could not generate enough distinct questions. Please try again.');
      error.status = 502;
      throw error;
    }

    if (topic) {
      quizHistory.remember(topic, validatedQuestions);
      try {
        await TopicRequest.create({
          topic: String(topic).trim(),
          userId: req.user._id
        });
      } catch (trackingError) {
        console.error('Failed to record popular topic:', trackingError.message);
      }
    }

    return res.json({
      status: 'success',
      data: validatedQuestions,
      cached: false
    });
  } catch (error) {
    console.error('Quiz generation error:', error);
    
    // Determine appropriate status and message
    let status = error.status || 500;
    let message = 'Failed to generate quiz: ' + error.message;
    
    if (error.message?.includes('API key')) {
      status = 401;
      message = 'Invalid or missing Groq API key';
    } else if (isQuotaError(error)) {
      status = 429;
      message = 'Groq rejected the request because its rate or usage limit was reached. Try again later, check your Groq limits, or use a cached quiz.';
    } else if (error.status === 404 || error.status === 400) {
      status = 502;
      message = 'The configured Groq model is unavailable or does not support this request. Check GENAI_MODEL and GENAI_FALLBACK_MODELS.';
    } else if (error.status === 502) {
      message = error.message;
    } else if (error.message?.includes('Service Unavailable') || error.message?.includes('high demand')) {
      status = 503;
      message = 'AI service is temporarily overloaded. Please try again in a few moments.';
    }
    
    res.status(status).json({
      status: 'error',
      message
    });
  }
};
