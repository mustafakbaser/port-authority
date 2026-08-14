import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'out/**', 'node_modules/**', '*.mjs'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'off',
      'no-undef': 'off',
      eqeqeq: ['error', 'always'],
      curly: 'error',
      'no-throw-literal': 'error',
      // The core layer must stay free of editor APIs so it can be unit tested.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['vscode'],
              message: 'src/core must not depend on the VS Code API. Keep editor access in src/vscode.',
            },
          ],
        },
      ],
    },
  },
  {
    // Only the core layer is restricted; the adapter layer exists to use `vscode`.
    files: ['src/extension.ts', 'src/vscode/**/*.ts', 'src/test/integration/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
];
