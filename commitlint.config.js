export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'perf', 'docs', 'chore', 'ci', 'refactor', 'build', 'style', 'test', 'revert'],
    ],
    'subject-case': [0, 'always'],
    'subject-empty': [2, 'never'],
    'type-empty': [2, 'never'],
    'header-max-length': [2, 'always', 200],
  },
};
