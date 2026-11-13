import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Tests talk to the development stand; its connection comes from .env when present.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', 'inbox/**', 'web/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
