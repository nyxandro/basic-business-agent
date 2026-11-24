// The pool when the database drops a connection (a restart of Postgres, a network blip) or every connection is taken:
// the server goes on, the request that lost its connection fails with an error, and nobody waits forever.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, inTransaction, isPoolExhausted, withLock } from './pool.ts';
import { createTestDatabase, type TestDatabase } from './test-database.ts';

let database: TestDatabase;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase();
  admin = new pg.Client({ connectionString: database.url });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await database.drop();
});

const pidOf = async (q: { query: pg.Pool['query'] }) => (await q.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
const drop = (pid: number) => admin.query('SELECT pg_terminate_backend($1)', [pid]);

describe('pool', () => {
  it('stays up when the database drops an idle connection, and the next query gets a new one', async () => {
    const pool = createPool(database.url);
    await drop(await pidOf(pool));
    await expect.poll(() => pool.totalCount).toBe(0);
    expect((await pool.query<{ one: number }>('SELECT 1 AS one')).rows[0]!.one).toBe(1);
    await pool.end();
  });

  it('fails the transaction whose connection the database dropped while it waited, and gives the next query a good one', async () => {
    const pool = createPool(database.url);
    const lost = inTransaction(pool, async (c) => {
      await drop(await pidOf(c));
      // The connection is idle inside the transaction when it goes — as while a transaction waits for another service.
      await new Promise((r) => setTimeout(r, 300));
      await c.query('SELECT 1');
    });
    await expect(lost).rejects.toThrow();
    for (let i = 0; i < 3; i++) expect((await pool.query<{ one: number }>('SELECT 1 AS one')).rows[0]!.one).toBe(1);
    await pool.end();
  });

  it('tells a pool with every connection taken by the error of the library, not by a guess', async () => {
    const tiny = new pg.Pool({ connectionString: database.url, max: 1, connectionTimeoutMillis: 100 });
    const held = await tiny.connect();
    const waited = await tiny.query('SELECT 1').catch((error: unknown) => error);
    expect(isPoolExhausted(waited)).toBe(true);
    expect(isPoolExhausted(new Error('relation "x" does not exist'))).toBe(false);
    held.release();
    await tiny.end();
  });

  it('runs the holders of one lock one after another on one connection each, and keeps what each wrote at once', async () => {
    // One connection only: whoever needs a second one while holding the lock would wait forever.
    const tiny = new pg.Pool({ connectionString: database.url, max: 1, connectionTimeoutMillis: 5_000 });
    await admin.query('CREATE TABLE IF NOT EXISTS lock_log (n int)');
    const order: number[] = [];
    const holder = (n: number) =>
      withLock(tiny, 'probe', async (client) => {
        order.push(n);
        await client.query('INSERT INTO lock_log (n) VALUES ($1)', [n]);
        // Saved at once: another connection sees it while the lock is still held.
        expect((await admin.query<{ c: number }>('SELECT count(*)::int AS c FROM lock_log WHERE n = $1', [n])).rows[0]!.c).toBe(1);
        await new Promise((r) => setTimeout(r, 50));
        return n;
      });
    expect(await Promise.all([holder(1), holder(2), holder(3)])).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
    await expect(withLock(tiny, 'probe', () => Promise.reject(new Error('inside')))).rejects.toThrow('inside');
    // The lock is let go after a failure too.
    expect(await withLock(tiny, 'probe', () => Promise.resolve('free'))).toBe('free');
    await tiny.end();
  });
});
