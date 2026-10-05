import Groq from 'groq-sdk';
import { quizCache } from '../utils/cacheUtil.js';

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
const NON_CHAT_MODEL = /whisper|audio|speech|tts|embedding|embed|guard|moderation|transcription|translation/i;
let modelListCache = { fetchedAt: 0, ids: null };

const getAvailableModelIds = async (groq) => {
  if (modelListCache.ids && Date.now() - modelListCache.fetchedAt < MODEL_LIST_TTL_MS) {
    return modelListCache.ids;
  }

  const response = await groq.models.list();
  const ids = (response.data || []).map(model => model.id).filter(Boolean);
  modelListCache = { fetchedAt: Date.now(), ids };
  return ids;
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

// Retry logic for temporary failures
const retryWithBackoff = async (fn, maxRetries = 3, baseDelay = 1000) => {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Check if error is retryable (5xx status codes or specific messages)
      const isRetryable = 
        error.status >= 500 || 
        error.message?.includes('Service Unavailable') ||
        error.message?.includes('temporarily') ||
        error.message?.includes('high demand');
      
      if (!isRetryable || attempt === maxRetries - 1) {
        throw error;
      }
      
      // Exponential backoff: wait before retrying
      const delay = baseDelay * Math.pow(2, attempt);
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
    
    // Check cache if structured parameters are provided
    if (topic && numQuestions && difficulty) {
      const cachedQuiz = quizCache.get(topic, numQuestions, difficulty);
      if (cachedQuiz) {
        return res.json({
          status: 'success',
          data: cachedQuiz,
          cached: true
        });
      }
    }

    if (!prompt) {
      return res.status(400).json({
        status: 'error',
        message: 'Prompt is required'
      });
    }

    // Wrap the API call with retry logic and dynamic model selection
    const generateContent = async () => {
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

      // Primary model can be overridden through environment.
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
        // Model discovery is best-effort; still try configured IDs if the listing endpoint is unavailable.
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
              content: 'You are an expert educational quiz generator. Output ONLY valid JSON containing an array of questions according to the requested format. Do not include markdown code blocks or any other explanation text.'
            },
            {
              role: 'user',
              content: prompt
            }
          ];
          let result;
          try {
            result = await groq.chat.completions.create({
              messages,
              model: candidateModel,
              response_format: { type: 'json_object' },
              temperature: 0.7,
              max_tokens: 2048,
            });
          } catch (requestError) {
            const requestMessage = (requestError?.message || '').toLowerCase();
            const canRetryWithoutJsonMode = requestError?.status === 400 &&
              /json|response_format|max_tokens|unsupported parameter/.test(requestMessage);
            if (!canRetryWithoutJsonMode) throw requestError;

            console.warn(`Retrying ${candidateModel} without JSON-mode options.`);
            result = await groq.chat.completions.create({
              messages,
              model: candidateModel,
              temperature: 0.7
            });
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

          if (shouldTryNextModel) {
            continue;
          }

          // For non-model-specific failures, surface immediately so retryWithBackoff can retry.
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

    const text = await retryWithBackoff(generateContent);

    // Clean markdown formatting if present
    let cleanText = text.replace(/```json|```/g, '').trim();
    
    try {
      const parsed = JSON.parse(cleanText);
      
      // Validate questions structure
      if (Array.isArray(parsed.questions || parsed)) {
        const questions = parsed.questions || parsed;
        const validatedQuestions = questions.map(q => ({
          ...q,
          correctAnswer: typeof q.correctAnswer === 'number' ? q.correctAnswer : q.answer
        }));
        
        // Cache the result if structured parameters are available
        if (topic && numQuestions && difficulty) {
          quizCache.set(topic, numQuestions, difficulty, validatedQuestions);
        }
        
        return res.json({
          status: 'success',
          data: validatedQuestions,
          cached: false
        });
      }
      
      throw new Error('Invalid question format');
    } catch (parseError) {
      console.error('JSON parsing error:', parseError);
      return res.status(400).json({
        status: 'error',
        message: 'AI response format invalid. Expected array of questions with correctAnswer field.'
      });
    }
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

