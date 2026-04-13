// backend/routes/resultRoutes.js
import express from 'express';
import { saveResult, getUserQuizHistory, getPerformanceDetails, getUserHistory, getUserRewards } from '../controllers/resultController.js';
import { protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/saveresult',protect,saveResult);
router.get('/getresults',protect, getUserQuizHistory);
router.get('/performance', protect, getPerformanceDetails);
router.get('/history', protect, getUserHistory);
router.get('/rewards', protect, getUserRewards);
export default router;