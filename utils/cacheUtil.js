// Simple in-memory cache with TTL (Time To Live)
class QuizCache {
  constructor(ttlMs = 24 * 60 * 60 * 1000) { // 24 hours default
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }

  // Create a cache key from the quiz parameters
  getCacheKey(topic, numQuestions, difficulty) {
    return `quiz_${topic.toLowerCase().replace(/\s+/g, '_')}_${numQuestions}_${difficulty.toLowerCase()}`;
  }

  // Get cached quiz if it exists and hasn't expired
  get(topic, numQuestions, difficulty) {
    const key = this.getCacheKey(topic, numQuestions, difficulty);
    const cached = this.cache.get(key);

    if (!cached) return null;

    if (Date.now() - cached.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    console.log(`Cache hit for ${key}`);
    return cached.data;
  }

  // Store a quiz in cache
  set(topic, numQuestions, difficulty, data) {
    const key = this.getCacheKey(topic, numQuestions, difficulty);
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
    console.log(`Cached quiz: ${key}`);
  }

  // Clear expired entries periodically
  cleanup() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }

  // Get cache stats
  getStats() {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys())
    };
  }
}

export const quizCache = new QuizCache();

// Cleanup expired entries every 30 minutes
setInterval(() => {
  quizCache.cleanup();
  console.log('Quiz cache cleaned up');
}, 30 * 60 * 1000);
