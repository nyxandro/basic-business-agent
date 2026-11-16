// GET /app/api/search (spec, section 8.13): the signed-in person's own projects and conversations.
import { SEARCH_SCOPES } from '@bba/contracts';
import type { Hono } from 'hono';
import { z } from 'zod';
import { appError } from '../errors/catalog.ts';
import type { ProjectsDeps } from '../projects/projects.ts';
import { logEvent } from '../server/log.ts';
import { access, type AppEnv } from '../server/http.ts';
import { search } from './search.ts';

const SLOW_SEARCH_MS = 300;

const querySchema = z.object({
  q: z.string(),
  scope: z.enum(SEARCH_SCOPES).default('all'),
});

export function registerSearchRoutes(app: Hono<AppEnv>, deps: ProjectsDeps): void {
  app.get('/app/api/search', async (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) throw appError('APP_VALIDATION_FAILED', `bad search query: ${parsed.error.message}`);
    const userId = access(c).userId;
    try {
      const started = performance.now();
      const result = await search(deps, userId, { q: parsed.data.q, scope: parsed.data.scope });
      const ms = Math.round(performance.now() - started);
      // The spec moves search to a full-text index when it gets slower than this (section 4).
      if (ms > SLOW_SEARCH_MS) logEvent('warn', 'search_slow', { userId, ms, words: parsed.data.q.split(/\s+/).length });
      return c.json(result);
    } catch (error) {
      if ((error as { code?: string }).code === 'APP_VALIDATION_FAILED') throw error;
      logEvent('error', 'search_failed', { code: 'APP_SEARCH_FAILED', userId, error });
      throw appError('APP_SEARCH_FAILED', 'search query failed', { cause: error });
    }
  });
}
