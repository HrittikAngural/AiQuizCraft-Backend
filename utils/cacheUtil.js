// Recent question history prevents the same quiz from being served repeatedly.
class QuizHistory {
  constructor(ttlMs = 7 * 24 * 60 * 60 * 1000, maxTopics = 500, maxQuestions = 50) {
    this.history = new Map();
    this.ttlMs = ttlMs;
    this.maxTopics = maxTopics;
    this.maxQuestions = maxQuestions;
  }

  getKey(topic) {
    return String(topic).trim().toLowerCase();
  }

  getRecentQuestions(topic) {
    const key = this.getKey(topic);
    const entry = this.history.get(key);

    if (!entry) return [];

    if (Date.now() - entry.updatedAt > this.ttlMs) {
      this.history.delete(key);
      return [];
    }

    return entry.questions.map(question => question.text);
  }

  remember(topic, questions) {
    const key = this.getKey(topic);
    const entry = this.history.get(key) || { questions: [], updatedAt: Date.now() };
    const seen = new Set(entry.questions.map(question => question.normalized));

    for (const question of questions) {
      const text = String(question?.question || '').trim();
      const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!normalized || seen.has(normalized)) continue;
      entry.questions.push({ text, normalized });
      seen.add(normalized);
    }

    entry.updatedAt = Date.now();
    entry.questions = entry.questions.slice(-this.maxQuestions);
    this.history.delete(key);
    this.history.set(key, entry);

    while (this.history.size > this.maxTopics) {
      this.history.delete(this.history.keys().next().value);
    }
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.history.entries()) {
      if (now - entry.updatedAt > this.ttlMs) {
        this.history.delete(key);
      }
    }
  }
}

export const quizHistory = new QuizHistory();

setInterval(() => {
  quizHistory.cleanup();
}, 30 * 60 * 1000);
