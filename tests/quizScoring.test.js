import test from 'node:test';
import assert from 'node:assert/strict';
import { getPointsPerCorrectAnswer, normalizeDifficulty } from '../utils/quizScoring.js';

test('subject quizzes award points based on selected difficulty', () => {
  const subject = 'Computer Science';

  assert.equal(getPointsPerCorrectAnswer({ isSubjectQuiz: true, subject, difficulty: 'Easy' }), 1);
  assert.equal(getPointsPerCorrectAnswer({ isSubjectQuiz: true, subject, difficulty: 'Medium' }), 2);
  assert.equal(getPointsPerCorrectAnswer({ isSubjectQuiz: true, subject, difficulty: 'Hard' }), 4);
});

test('normal quizzes award one point regardless of difficulty', () => {
  for (const difficulty of ['Easy', 'Medium', 'Hard']) {
    assert.equal(getPointsPerCorrectAnswer({ isSubjectQuiz: false, subject: '', difficulty }), 1);
  }
});

test('difficulty normalization is case-insensitive and defaults to medium', () => {
  assert.equal(normalizeDifficulty('hard'), 'Hard');
  assert.equal(normalizeDifficulty('unrecognized'), 'Medium');
});
