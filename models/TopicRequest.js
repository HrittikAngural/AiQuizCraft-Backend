import mongoose from 'mongoose';

const topicRequestSchema = new mongoose.Schema({
  topic: { type: String, required: true, trim: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now }
});

topicRequestSchema.index({ createdAt: -1 });

export default mongoose.model('TopicRequest', topicRequestSchema);