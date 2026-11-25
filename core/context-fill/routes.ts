// How full one's own conversation is (spec, section 8.34): the chat asks when a conversation opens and after an answer.
import type { ThreadContextResponse } from '@bba/contracts';
import type { Hono } from 'hono';
import type { Db } from '../db/pool.ts';
import { access, type AppEnv } from '../http/http.ts';
import { fillOf } from './store.ts';

export function registerContextFillRoutes(app: Hono<AppEnv>, deps: { db: Db }): void {
  app.get('/app/api/threads/:threadId/context', async (c) => {
    const body: ThreadContextResponse = { context: await fillOf(deps.db, access(c).userId, c.req.param('threadId')) };
    return c.json(body);
  });
}
