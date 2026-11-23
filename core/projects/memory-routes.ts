// The memory of a project on its page (spec, section 8.26), reached only through the rule of access.ts: whoever sees
// the project reads and changes it (decision of the owner 17.11, F16-A); an archived one only its creator reads.
import type { Context, Hono } from 'hono';
import type { Db } from '../db/pool.ts';
import { access, type AppEnv } from '../http/http.ts';
import type { MemoryScope } from '../memory/entries.ts';
import { memoryEntryHandlers } from '../memory/routes.ts';
import { requireActive, visibleProject } from './access.ts';

export function registerProjectMemoryRoutes(app: Hono<AppEnv>, deps: { db: Db }): void {
  const { db } = deps;
  const { list, add, change, remove } = memoryEntryHandlers(db);

  async function projectScope(c: Context<AppEnv>, write: boolean): Promise<{ scope: MemoryScope; readOnly: boolean }> {
    const found = await visibleProject(db, access(c).userId, c.req.param('id') ?? '', 'owner');
    if (write) requireActive(found);
    return { scope: { kind: 'project', projectId: found.project.id }, readOnly: found.project.archived_at !== null };
  }

  app.get('/app/api/projects/:id/memory', async (c) => {
    const { scope, readOnly } = await projectScope(c, false);
    return list(c, scope, readOnly);
  });
  app.post('/app/api/projects/:id/memory', async (c) => add(c, (await projectScope(c, true)).scope));
  app.put('/app/api/projects/:id/memory/:entryId', async (c) => change(c, (await projectScope(c, true)).scope));
  app.delete('/app/api/projects/:id/memory/:entryId', async (c) => remove(c, (await projectScope(c, true)).scope));
}
