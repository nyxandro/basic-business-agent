import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Tests talk to the development stand; its connection comes from .env when present.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', 'inbox/**', 'web/**'],
    environment: 'node',
    // Every test file has its own app with its own pools on the stand's Postgres (max_connections 100, shared with pnpm dev):
    // 12 files at once ran out of connections («too many clients already», 22.11); 6 keep all files green.
    maxWorkers: 6,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
