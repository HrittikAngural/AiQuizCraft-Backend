const difficultyLevels = ['Easy', 'Medium', 'Hard'];

export const normalizeDifficulty = (difficulty) => (
  difficultyLevels.find(
    (level) => level.toLowerCase() === String(difficulty || '').toLowerCase()
  ) || 'Medium'
);

export const getPointsPerCorrectAnswer = ({ isSubjectQuiz, subject, difficulty }) => {
  if (!isSubjectQuiz || !subject) return 1;
  return { Easy: 1, Medium: 2, Hard: 4 }[normalizeDifficulty(difficulty)];
};
