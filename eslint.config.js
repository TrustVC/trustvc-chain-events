import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';

export default [
  // TypeScript-ESLint recommended rules (flat-config format, no type-checking required).
  ...tseslint.configs['flat/recommended'],

  // Project-wide overrides applied on top of recommended.
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
    },
    rules: {
      // Allow _-prefixed names for intentionally unused vars, args, and caught errors.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // `any` is sometimes needed at system boundaries (e.g. IPC, ethers internals).
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // Disable all formatting rules that Prettier owns so the two tools don't conflict.
  prettierConfig,

  // Never lint generated output or third-party code.
  {
    ignores: ['dist/**', 'coverage/**', 'scripts/**', 'node_modules/**'],
  },
];
