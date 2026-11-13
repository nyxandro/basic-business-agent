// Test helper: a fresh, empty database per test file on the development stand (deploy/compose.dev.yaml).
// Tests never share data, and dropping the database removes everything a test created.
import { randomBytes } from 'node:crypto';
import pg from 'pg';

export interface TestDatabase {
  url: string;
  drop(): Promise<void>;
}

function baseUrl(): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('DATABASE_URL is not set: start the dev stand (pnpm dev:db) and copy .env.example to .env');
  }
  return new URL(raw);
}

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: baseUrl().toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `bba_test_${randomBytes(6).toString('hex')}`;
  await admin((c) => c.query(`CREATE DATABASE "${name}"`));
  const url = baseUrl();
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () => admin(async (c) => void (await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`))),
  };
}
