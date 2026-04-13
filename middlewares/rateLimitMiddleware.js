// Simple in-memory rate limiter
const requestCounts = new Map();

export const rateLimit = (windowMs = 60000, maxRequests = 3) => {
  return (req, res, next) => {
    const key = `${req.user?.id || req.ip}`;
    const now = Date.now();
    
    if (!requestCounts.has(key)) {
      requestCounts.set(key, []);
    }
    
    const timestamps = requestCounts.get(key);
    
    // Remove old timestamps outside the window
    const recentTimestamps = timestamps.filter(t => now - t < windowMs);
    
    if (recentTimestamps.length >= maxRequests) {
      const oldestTime = recentTimestamps[0];
      const resetTime = new Date(oldestTime + windowMs).toISOString();
      
      return res.status(429).json({
        status: 'error',
        message: `Too many requests. Please wait before generating another quiz.`,
        retryAfter: Math.ceil((oldestTime + windowMs - now) / 1000),
        resetTime
      });
    }
    
    recentTimestamps.push(now);
    requestCounts.set(key, recentTimestamps);
    
    next();
  };
};

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of requestCounts.entries()) {
    const recent = timestamps.filter(t => now - t < 3600000); // Keep 1 hour history
    if (recent.length === 0) {
      requestCounts.delete(key);
    } else {
      requestCounts.set(key, recent);
    }
  }
}, 60000); // Cleanup every minute
