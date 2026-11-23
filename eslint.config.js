import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const ENV_RULE = 'Read environment variables only in an entry point (core/server/main.ts, core/cli/*) and pass the value as a parameter.';

export default defineConfig(
  // core/system-skills: skills of Anthropic kept exactly as published (spec, section 8.18).
  // .data: the development installation's data, including scripts agents write in their workspace.
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'inbox/**', 'docs/**', '.venv-skills/**', '.data/**', 'core/system-skills/*/**', 'core/mcp-runner/fixtures/**'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      // A source file is at most 800 lines (counted as `wc -l`): a longer one is split into modules.
      'max-lines': ['error', { max: 800 }],
      // Library calls marked deprecated: they go away in the next versions of the library.
      '@typescript-eslint/no-deprecated': 'error',
      // A new variant of a union fails the lint wherever a switch over it forgot the variant; `default` counts as handling it.
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      // `import { type A } from './a.ts'` still loads the file when the code runs; `import type` does not. Only the second
      // form is what the architecture check counts as a type (no circle, no dependency of modules at run time).
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  // Environment variables hold only secrets and addresses (AGENTS.md): the entry points read them and pass values on.
  {
    files: ['core/**/*.ts', 'plugins/**/*.ts', 'config/**/*.ts', 'agents/**/*.ts', 'custom/**/*.ts', 'workflows/**/*.ts', 'contracts/**/*.ts'],
    ignores: ['core/server/main.ts', 'core/cli/**', 'core/mcp-runner/main.ts', 'core/server/test-app.ts', 'core/db/test-database.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-properties': ['error', { object: 'process', property: 'env', message: ENV_RULE }],
      'no-restricted-imports': ['error', { paths: ['node:process', 'process'].map((name) => ({ name, importNames: ['env'], message: ENV_RULE })) }],
    },
  },
  // The journal of the server is one: structured lines with codes through logEvent (core/log/log.ts).
  {
    files: ['core/**/*.ts', 'plugins/**/*.ts'],
    ignores: ['core/log/log.ts', 'core/cli/**', '**/*.test.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
  // Vitest's asymmetric matchers (expect.any, expect.stringContaining) are typed as any.
  { files: ['**/*.test.ts', '**/*.test.tsx'], rules: { '@typescript-eslint/no-unsafe-assignment': 'off' } },
);
