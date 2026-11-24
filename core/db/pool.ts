import pg from 'pg';
import { logEvent } from '../log/log.ts';

export type Db = pg.Pool;

// Connections of one pool: requests of ~10 people at once, each a few queries, with room to spare (Postgres has 100 for
// the installation: this pool, the one of Better Auth, Mastra's 20, LiteLLM's).
export const POOL_MAX = 20;
// A request waits this long for a free connection, then fails with «сервер перегружен» (APP_SERVER_BUSY) instead of
// waiting forever: a pool stuck for good used to hang every request of the server (review 24.11).
export const POOL_WAIT_MS = 10_000;
const AUTH_POOL_MAX = 10;

// The database may drop any connection — a restart of Postgres, a network blip. pg reports it as an «error» event of the
// connection (and of the pool for an idle one), and an event nobody listens to stops the whole process. A dropped idle
// connection is replaced by the next query; a request whose connection went fails with the error of its query.
function keepAlive(pool: pg.Pool, name: string): pg.Pool {
  pool.on('connect', (client) => {
    client.on('error', (error) => logEvent('error', 'db_connection_lost', { code: 'APP_DB_CONNECTION_LOST', pool: name, error }));
  });
  pool.on('error', (error) => logEvent('error', 'db_idle_connection_lost', { code: 'APP_DB_CONNECTION_LOST', pool: name, error }));
  return pool;
}

export function createPool(databaseUrl: string): Db {
  return keepAlive(new pg.Pool({ connectionString: databaseUrl, max: POOL_MAX, connectionTimeoutMillis: POOL_WAIT_MS }), 'app');
}

// Better Auth issues unqualified table names; its tables live in schema `app`.
export function createAuthPool(databaseUrl: string): Db {
  return keepAlive(new pg.Pool({ connectionString: databaseUrl, options: '-c search_path=app', max: AUTH_POOL_MAX, connectionTimeoutMillis: POOL_WAIT_MS }), 'auth');
}

// The error pg-pool gives a request that waited `connectionTimeoutMillis` for a connection (pg-pool 3.14, index.js).
const POOL_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

export function isPoolExhausted(error: unknown): boolean {
  return error instanceof Error && error.message === POOL_TIMEOUT_MESSAGE;
}

// The database dropped the connection of a request: Postgres shut it down (57P01–57P03 — an administrator, a crash, a
// restart under way), or pg lost the socket.
const CONNECTION_LOST_CODES = new Set(['57P01', '57P02', '57P03']);
const CONNECTION_LOST_MESSAGES = new Set(['Connection terminated unexpectedly', 'Connection terminated', 'Client has encountered a connection error and is not queryable', 'Client was closed and is not queryable']);

export function isConnectionLost(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (typeof code === 'string' && CONNECTION_LOST_CODES.has(code)) || CONNECTION_LOST_MESSAGES.has(error.message);
}

// Runs `fn` in a transaction on the given connection: commits, or rolls back and rethrows the error of `fn`.
export async function transactionOn<T>(client: pg.PoolClient, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch((rollback: unknown) => {
      logEvent('error', 'db_rollback_failed', { code: 'APP_DB_CONNECTION_LOST', error: rollback });
      // A connection the rollback could not reach may still hold the transaction: it is closed, and the pool drops it
      // when it is released instead of giving it to the next request.
      void client.end().catch(() => undefined);
    });
    throw error;
  }
}

// Runs `fn` in a transaction on one connection. Inside, query only through `client`: a second connection taken from the
// pool while this one is held is how ten requests at once hung the server for good (review 24.11).
export async function inTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    return await transactionOn(client, fn);
  } finally {
    client.release();
  }
}

// Runs `fn` alone among callers with the same `key` (a lock of the session in Postgres), on one connection held for it.
// Each query of `fn` through `client` is saved at once, not at the end — a token a service rotated is never lost to a
// later failure. Inside, query only through `client`: waiters hold their own connection while they wait.
export async function withLock<T>(db: Db, key: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    try {
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch((error: unknown) => {
        logEvent('error', 'db_unlock_failed', { code: 'APP_DB_CONNECTION_LOST', error });
        // The lock may still be held by this session: it is closed (the lock goes with it), never reused.
        void client.end().catch(() => undefined);
      });
    }
  } finally {
    client.release();
  }
}
