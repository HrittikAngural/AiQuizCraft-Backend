import Groq from 'groq-sdk';
import { quizCache } from '../utils/cacheUtil.js';

const DEFAULT_FALLBACK_MODELS = [
  'models/gemini-2.0-flash',
  'models/gemini-1.5-flash'
];

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

const supportsGenerate = (modelMeta) => {
  const methods = modelMeta?.supportedMethods || modelMeta?.supported_methods || modelMeta?.methods || [];
  return methods.includes('generateContent') || methods.includes('generate');
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

      const candidates = unique([
        selectedModel,
        ...fallbackModels
      ]);

      const failures = [];
      for (const candidateModel of candidates) {
        try {
          const result = await groq.chat.completions.create({
            messages: [
              {
                role: 'system',
                content: 'You are an expert educational quiz generator. Output ONLY valid JSON containing an array of questions according to the requested format. Do not include markdown code blocks or any other explanation text.'
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            model: candidateModel,
            response_format: { type: 'json_object' },
            temperature: 0.7,
            max_tokens: 2048,
          });
          return result.choices[0]?.message?.content || '';
        } catch (genErr) {
          failures.push(`${candidateModel}: ${genErr?.message || genErr}`);

          const msg = (genErr?.message || '').toLowerCase();
          const shouldTryNextModel =
            isQuotaError(genErr) ||
            msg.includes('not found') ||
            msg.includes('not supported') ||
            genErr?.status === 404 || 
            genErr?.status === 429;

          if (shouldTryNextModel) {
            continue;
          }

          // For non-model-specific failures, surface immediately so retryWithBackoff can retry.
          const err = new Error(`${candidateModel}: ${genErr?.message || genErr}`);
          err.status = genErr?.status || genErr?.code || 500;
          throw err;
        }
      }

      const hint = `All candidate models failed. Tried: ${failures.join(' | ')}.`;
      const err = new Error(hint);
      err.status = 429;
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
    let status = 500;
    let message = 'Failed to generate quiz: ' + error.message;
    
    if (error.message?.includes('API key')) {
      status = 401;
      message = 'Invalid or missing Groq API key';
    } else if (isQuotaError(error)) {
      status = 429;
      message = 'Groq quota exceeded. Tip: Try the same topic/difficulty again to use the cached quiz instead. Consider upgrading your API key for production use.';
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

