// backend/models/Result.js
import mongoose from 'mongoose';

const resultSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  topic: { type: String, required: true },
  score: { type: Number, required: true },
  totalQuestions: { type: Number, required: true },
  attempted: { type: Number, required: true },
  timeTaken: { type: Number, required: true }, // in seconds
  createdAt: { type: Date, default: Date.now },
  reward: { type: String, enum: ['gold', 'silver', 'bronze', ''], default: '' }
});

export default mongoose.model('Result', resultSchema);