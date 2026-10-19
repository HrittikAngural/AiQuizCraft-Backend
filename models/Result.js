// backend/models/Result.js
import mongoose from 'mongoose';

const answerDetailSchema = new mongoose.Schema({
  question: { type: String, required: true },
  options: { type: [String], required: true },
  correctAnswer: { type: Number, required: true },
  selectedOption: { type: Number, default: null },
  explanation: { type: String, default: '' }
}, { _id: false });

const resultSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  attemptId: { type: String, trim: true },
  topic: { type: String, required: true },
  subject: { type: String, default: '' },
  score: { type: Number, required: true },
  points: { type: Number, min: 0 },
  difficulty: { type: String, enum: ['Easy', 'Medium', 'Hard'], default: 'Medium' },
  totalQuestions: { type: Number, required: true },
  attempted: { type: Number, required: true },
  timeTaken: { type: Number, required: true }, // in seconds
  answerDetails: { type: [answerDetailSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  reward: { type: String, enum: ['gold', 'silver', 'bronze', ''], default: '' }
});

resultSchema.index(
  { userId: 1, attemptId: 1 },
  { unique: true, partialFilterExpression: { attemptId: { $type: 'string' } } }
);

export default mongoose.model('Result', resultSchema);