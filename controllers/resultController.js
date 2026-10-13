// backend/controllers/resultController.js
import Result from '../models/Result.js';
import User from '../models/User.js';
import TopicRequest from '../models/TopicRequest.js';

export const getLeaderboard = async (req, res) => {
  try {
    const period = String(req.query.period || 'all').toLowerCase();
    const periodDays = { weekly: 7, monthly: 30, all: null };
    if (!Object.hasOwn(periodDays, period)) {
      return res.status(400).json({ message: 'Period must be weekly, monthly, or all.' });
    }

    const periodMatch = periodDays[period]
      ? { createdAt: { $gte: new Date(Date.now() - periodDays[period] * 24 * 60 * 60 * 1000) } }
      : {};
    const rankedUsers = await Result.aggregate([
      { $match: periodMatch },
      {
        $group: {
          _id: '$userId',
          points: { $sum: '$score' },
          quizzes: { $sum: 1 },
          correctAnswers: { $sum: '$score' },
          totalQuestions: { $sum: '$totalQuestions' }
        }
      },
      { $lookup: { from: User.collection.name, localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      {
        $project: {
          _id: 0,
          userId: { $toString: '$_id' },
          name: '$user.name',
          points: 1,
          quizzes: 1,
          totalQuestions: 1,
          correctAnswers: 1
        }
      },
      { $sort: { points: -1, correctAnswers: -1, quizzes: -1, name: 1 } }
    ]);

    const allTimeResults = await Result.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .select('topic subject score totalQuestions attempted createdAt reward');
    const userId = String(req.user.id);
    const currentIndex = rankedUsers.findIndex((entry) => entry.userId === userId);
    const currentUser = await User.findById(req.user.id).select('name');
    const selectedPeriodStats = currentIndex >= 0 ? rankedUsers[currentIndex] : null;
    const allTimePoints = allTimeResults.reduce((sum, result) => sum + (Number(result.score) || 0), 0);
    const allTimeQuestions = allTimeResults.reduce((sum, result) => sum + (Number(result.totalQuestions) || 0), 0);
    const allTimeCorrect = allTimeResults.reduce((sum, result) => sum + (Number(result.score) || 0), 0);

    return res.status(200).json({
      period,
      leaderboard: rankedUsers.slice(0, 100).map((entry, index) => ({
        ...entry,
        rank: index + 1,
        level: Math.floor(entry.points / 100) + 1,
        accuracy: entry.totalQuestions
          ? Math.round((entry.correctAnswers / entry.totalQuestions) * 100)
          : 0
      })),
      currentUser: {
        id: userId,
        name: currentUser?.name || 'You',
        points: selectedPeriodStats?.points || 0,
        rank: currentIndex >= 0 ? currentIndex + 1 : null,
        allTimePoints,
        quizzes: allTimeResults.length,
        accuracy: allTimeQuestions ? Math.round((allTimeCorrect / allTimeQuestions) * 100) : 0,
        level: Math.floor(allTimePoints / 100) + 1
      },
      myResults: allTimeResults
    });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    return res.status(500).json({ message: 'Failed to fetch leaderboard.' });
  }
};

export const getPopularTopics = async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const aggregateTopics = (model) => model.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $toLower: { $trim: { input: '$topic' } } },
          topic: { $first: { $trim: { input: '$topic' } } },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1, topic: 1 } },
      { $limit: 12 },
      { $project: { _id: 0, topic: 1, count: 1 } }
    ]);
    let topics = await aggregateTopics(TopicRequest);

    if (!topics.length) {
      topics = await aggregateTopics(Result);
    }

    res.status(200).json({ topics, periodDays: 30 });
  } catch (error) {
    console.error('Error fetching popular topics:', error);
    res.status(500).json({ message: 'Failed to fetch popular topics' });
  }
};

export const saveResult = async (req, res) => {
  const session = await Result.startSession();
  session.startTransaction();
  
  try {
    const { attemptId, topic, subject, score, totalQuestions, attempted, timeTaken, reward } = req.body;

    const duplicateFilter = attemptId
      ? { userId: req.user._id, attemptId }
      : { userId: req.user._id, topic, createdAt: { $gt: new Date(Date.now() - 60 * 1000) } };
    const existing = await Result.findOne(duplicateFilter).session(session);
    
    if (existing) {
      await session.commitTransaction();
      return res.status(200).json(existing);
    }
    
    const result = new Result({
      userId: req.user._id,
      attemptId,
      topic,
      subject,
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

export const getRecentSearchedTopics = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const searches = await TopicRequest.find({ userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('topic createdAt');

    const recentTopics = [];
    const seenTopics = new Set();
    for (const search of searches) {
      const normalizedTopic = search.topic.trim().toLowerCase();
      if (!normalizedTopic || seenTopics.has(normalizedTopic)) continue;
      seenTopics.add(normalizedTopic);
      recentTopics.push(search);
      if (recentTopics.length === 5) break;
    }

    if (recentTopics.length) {
      return res.status(200).json(recentTopics);
    }

    const results = await Result.find({ userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('topic createdAt');
    const previousTopics = [];
    seenTopics.clear();

    for (const result of results) {
      const normalizedTopic = result.topic.trim().toLowerCase();
      if (!normalizedTopic || seenTopics.has(normalizedTopic)) continue;
      seenTopics.add(normalizedTopic);
      previousTopics.push(result);
      if (previousTopics.length === 5) break;
    }

    res.status(200).json(previousTopics);
  } catch (error) {
    console.error('Error fetching recent searched topics:', error);
    res.status(500).json({ message: 'Failed to fetch recent searched topics' });
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