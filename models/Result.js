// backend/models/Result.js
import mongoose from 'mongoose';

const resultSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  attemptId: { type: String, trim: true },
  topic: { type: String, required: true },
  subject: { type: String, default: '' },
  score: { type: Number, required: true },
  totalQuestions: { type: Number, required: true },
  attempted: { type: Number, required: true },
  timeTaken: { type: Number, required: true }, // in seconds
  createdAt: { type: Date, default: Date.now },
  reward: { type: String, enum: ['gold', 'silver', 'bronze', ''], default: '' }
});

resultSchema.index(
  { userId: 1, attemptId: 1 },
  { unique: true, partialFilterExpression: { attemptId: { $type: 'string' } } }
);

export default mongoose.model('Result', resultSchema);