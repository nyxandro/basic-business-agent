// POST /app/api/internal/usage — LiteLLM's callback with one usage record per model call.
// Reachable only inside the installation network (Caddy does not pass /app/api/internal/*)
// and only with the shared secret.
import { timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import type { Db } from '../db/pool.ts';
import { AppError } from '../errors/app-error.ts';
import { logEvent } from '../server/log.ts';
import type { AppEnv } from '../server/http.ts';
import { ingestUsage } from './usage.ts';

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerUsageRoutes(app: Hono<AppEnv>, deps: { db: Db; ledgerSecret: string }): void {
  app.post('/app/api/internal/usage', async (c) => {
    if (!sameSecret(c.req.header('authorization') ?? '', `Bearer ${deps.ledgerSecret}`)) {
      throw new AppError({ code: 'APP_INTERNAL_UNAUTHORIZED', message: 'usage callback without a valid secret', userMessage: 'Нет доступа.', status: 401 });
    }
    const payload: unknown = await c.req.json();
    try {
      const inserted = await ingestUsage(deps.db, payload);
      return c.json({ inserted });
    } catch (error) {
      logEvent('error', 'usage_ingest_failed', { code: 'APP_USAGE_PAYLOAD_INVALID', error });
      throw error;
    }
  });
}
