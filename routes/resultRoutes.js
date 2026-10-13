// backend/routes/resultRoutes.js
import express from 'express';
import { saveResult, getUserQuizHistory, getRecentSearchedTopics, getPerformanceDetails, getUserHistory, getUserRewards, getPopularTopics, getLeaderboard } from '../controllers/resultController.js';
import { protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/popular-topics', getPopularTopics);
router.get('/leaderboard', protect, getLeaderboard);
router.post('/saveresult',protect,saveResult);
router.get('/getresults',protect, getUserQuizHistory);
router.get('/recent-topics', protect, getRecentSearchedTopics);
router.get('/performance', protect, getPerformanceDetails);
router.get('/history', protect, getUserHistory);
router.get('/rewards', protect, getUserRewards);
export default router;