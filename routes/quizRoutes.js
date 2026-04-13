import express from 'express';
import { generateQuiz } from '../controllers/quizController.js';
import { protect } from '../middlewares/authMiddleware.js';
import { rateLimit } from '../middlewares/rateLimitMiddleware.js';

const router = express.Router();

// Rate limit: 3 requests per minute per user
router.post('/generate', protect, rateLimit(60000, 3), generateQuiz);


export default router;