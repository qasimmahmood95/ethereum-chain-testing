import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Core stays pure: viem and every RPC call live only in src/rpc/
    // (CLAUDE.md rule 3). Tests and harness may use viem freely.
    files: ['src/**/*.ts'],
    ignores: ['src/rpc/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['viem', 'viem/*', './rpc/*', '../rpc/*'],
              message:
                'viem (directly or via src/rpc) is only allowed in src/rpc/ — the core takes chain observations as data (CLAUDE.md rule 3).',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
