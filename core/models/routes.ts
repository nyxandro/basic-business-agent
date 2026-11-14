// LiteLLM's callbacks: POST /app/api/internal/usage — one usage record per model call;
// POST /app/api/internal/account-events — each failed attempt of a deployment.
// Reachable only inside the installation network (Caddy does not pass /app/api/internal/*)
// and only with the shared secret.
import { timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { Db } from '../db/pool.ts';
import { AppError } from '../errors/app-error.ts';
import { logEvent } from '../server/log.ts';
import type { AppEnv } from '../server/http.ts';
import { ingestAccountEvents } from './account-events.ts';
import type { ChatGptAccounts } from './chatgpt-accounts.ts';
import { ingestUsage } from './usage.ts';

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireSecret(c: Context<AppEnv>, secret: string, what: string): void {
  if (!sameSecret(c.req.header('authorization') ?? '', `Bearer ${secret}`)) {
    throw new AppError({ code: 'APP_INTERNAL_UNAUTHORIZED', message: `${what} callback without a valid secret`, userMessage: 'Нет доступа.', status: 401 });
  }
}

export function registerUsageRoutes(app: Hono<AppEnv>, deps: { db: Db; ledgerSecret: string; accounts: Pick<ChatGptAccounts, 'attemptFailed'> }): void {
  app.post('/app/api/internal/usage', async (c) => {
    requireSecret(c, deps.ledgerSecret, 'usage');
    const payload: unknown = await c.req.json();
    try {
      const inserted = await ingestUsage(deps.db, payload);
      return c.json({ inserted });
    } catch (error) {
      logEvent('error', 'usage_ingest_failed', { code: 'APP_USAGE_PAYLOAD_INVALID', error });
      throw error;
    }
  });

  app.post('/app/api/internal/account-events', async (c) => {
    requireSecret(c, deps.ledgerSecret, 'account events');
    const payload: unknown = await c.req.json();
    try {
      const kept = await ingestAccountEvents(deps.db, payload);
      for (const failure of kept) await deps.accounts.attemptFailed(failure.accountId, failure.status);
      return c.json({ kept: kept.length });
    } catch (error) {
      logEvent('error', 'account_events_ingest_failed', { error });
      throw error;
    }
  });
}
