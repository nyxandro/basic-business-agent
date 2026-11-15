import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // core/system-skills: skills of Anthropic kept exactly as published (spec, section 8.18).
  // .data: the development installation's data, including scripts agents write in their workspace.
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'inbox/**', 'docs/**', '.venv-skills/**', '.data/**', 'core/system-skills/*/**'] },
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
    },
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
