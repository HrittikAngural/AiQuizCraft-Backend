// backend/controllers/resultController.js
import Result from '../models/Result.js';

export const saveResult = async (req, res) => {
  const session = await Result.startSession();
  session.startTransaction();
  
  try {
    const { topic, score, totalQuestions, attempted, timeTaken, reward } = req.body;
    
    // More strict duplicate check
    const existing = await Result.findOne({
      userId: req.user._id,
      topic,
      createdAt: { $gt: new Date(Date.now() - 60 * 1000) }
    }).session(session);
    
    if (existing) {
      await session.commitTransaction();
      return res.status(200).json(existing);
    }
    
    const result = new Result({
      userId: req.user._id,
      topic,
      score,
      totalQuestions,
      attempted,
      timeTaken,
      reward
    });
    
    await result.save({ session });
    await session.commitTransaction();
    res.status(201).json(result);
  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ message: error.message });
  } finally {
    session.endSession();
  }
};

export const getUserQuizHistory = async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    
    const results = await Result.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('topic score createdAt');
      
    res.status(200).json(results);
  } catch (error) {
    console.error('Error fetching quiz history:', error);
    res.status(500).json({ message: 'Failed to fetch quiz history' });
  }
};

export const getPerformanceDetails = async (req, res) => {
  try {
    const results = await Result.find({ userId: req.user._id })
      .select('topic score totalQuestions createdAt');

    const analytics = {
      overallAccuracy: 0,
      byTopic: {},
      lastAttempted: null,
      totalQuizzes: results.length
    };

    if (results.length > 0) {
      // Calculate all metrics in a single pass
      results.forEach(result => {
        const accuracy = (result.score / result.totalQuestions * 100).toFixed(1);
        
        // Update overall stats
        analytics.overallAccuracy = 
          ((parseFloat(analytics.overallAccuracy) * (results.indexOf(result)) + parseFloat(accuracy)) / 
          (results.indexOf(result) + 1)).toFixed(1);
        
        // Update topic stats
        if (!analytics.byTopic[result.topic]) {
          analytics.byTopic[result.topic] = {
            accuracy: 0,
            attempts: 0,
            highestAccuracy: 0
          };
        }
        
        const topicData = analytics.byTopic[result.topic];
        topicData.accuracy = 
          ((parseFloat(topicData.accuracy) * topicData.attempts + parseFloat(accuracy)) / 
          (topicData.attempts + 1)).toFixed(1);
        topicData.attempts++;
        topicData.highestAccuracy = Math.max(topicData.highestAccuracy, accuracy);
      });

      analytics.lastAttempted = results[0].createdAt;
    }

    res.status(200).json(analytics);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// getUserHistory function
export const getUserHistory = async (req, res) => {
  try {
    const results = await Result.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .select('-userId'); // Exclude userId field
    
    res.status(200).json(results);
  } catch (err) {
    console.error('Error fetching user history:', err);
    res.status(500).json({ message: 'Error fetching quiz history' });
  }
};

export const getUserRewards = async (req, res) => {
  try {
    const rewards = await Result.find({ 
      userId: req.user.id,
      reward: { $in: ['gold', 'silver', 'bronze'] } // Only fetch these three reward types
    })
    .sort({ createdAt: -1 })
    .select('topic reward createdAt');
    
    res.status(200).json(rewards);
  } catch (err) {
    console.error('Error fetching user rewards:', err);
    res.status(500).json({ message: 'Error fetching rewards' });
  }
};