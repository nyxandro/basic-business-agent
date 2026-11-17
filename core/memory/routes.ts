// The memory of a project on its page and «Моя память» (spec, section 8.26). The memory of a project is
// reached only through the rule of core/projects/access.ts: whoever sees the project reads and changes it
// (decision of the owner 17.11, F16-A); an archived one only its creator reads. The personal memory is the
// employee's own.
import { memoryEntryChangeSchema, memoryEntryInputSchema, type MemoryEntryDto, type MemoryListDto } from '@bba/contracts';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { requireActive, visibleProject } from '../projects/access.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { addEntry, changeEntry, forgetPersonal, listEntries, removeEntry, type MemoryEntry, type MemoryScope } from './entries.ts';
import { forgetLegacyWorkingMemory } from './memory.ts';

export interface MemoryRoutesDeps {
  db: Db;
}

const entryIdSchema = z.uuid();

export function entryDto(entry: MemoryEntry, viewerId: string): MemoryEntryDto {
  return {
    id: entry.id,
    number: entry.number,
    text: entry.text,
    version: entry.version,
    editor: { name: entry.author.name, byAgent: entry.author.byAgent, you: entry.author.id === viewerId },
    updatedAt: entry.updatedAt.toISOString(),
  };
}

// An id that is not one names no entry.
function entryIdOf(c: Context<AppEnv>): string {
  const parsed = entryIdSchema.safeParse(c.req.param('entryId'));
  if (!parsed.success) throw appError('APP_MEMORY_ENTRY_NOT_FOUND', 'memory entry id is not a uuid');
  return parsed.data;
}

export function registerMemoryRoutes(app: Hono<AppEnv>, deps: MemoryRoutesDeps): void {
  const { db } = deps;

  async function projectScope(c: Context<AppEnv>, write: boolean): Promise<{ scope: MemoryScope; readOnly: boolean }> {
    const found = await visibleProject(db, access(c).userId, c.req.param('id') ?? '', 'owner');
    if (write) requireActive(found);
    return { scope: { kind: 'project', projectId: found.project.id }, readOnly: found.project.archived_at !== null };
  }

  const personalScope = (c: Context<AppEnv>): MemoryScope => ({ kind: 'personal', userId: access(c).userId });
  const actorOf = (c: Context<AppEnv>) => ({ userId: access(c).userId, byAgent: false });

  async function list(c: Context<AppEnv>, scope: MemoryScope, readOnly: boolean): Promise<Response> {
    const memory = await listEntries(db, scope);
    const body: MemoryListDto = { entries: memory.entries.map((e) => entryDto(e, access(c).userId)), usedChars: memory.usedChars, maxChars: memory.maxChars, readOnly };
    return c.json(body);
  }

  async function add(c: Context<AppEnv>, scope: MemoryScope): Promise<Response> {
    const { text } = await parseJson(c, memoryEntryInputSchema);
    return c.json(entryDto(await addEntry(db, scope, actorOf(c), text), access(c).userId));
  }

  async function change(c: Context<AppEnv>, scope: MemoryScope): Promise<Response> {
    const id = entryIdOf(c);
    const { text, version } = await parseJson(c, memoryEntryChangeSchema);
    return c.json(entryDto(await changeEntry(db, scope, actorOf(c), id, text, version), access(c).userId));
  }

  async function remove(c: Context<AppEnv>, scope: MemoryScope): Promise<Response> {
    return c.json(entryDto(await removeEntry(db, scope, entryIdOf(c)), access(c).userId));
  }

  app.get('/app/api/projects/:id/memory', async (c) => {
    const { scope, readOnly } = await projectScope(c, false);
    return list(c, scope, readOnly);
  });
  app.post('/app/api/projects/:id/memory', async (c) => add(c, (await projectScope(c, true)).scope));
  app.put('/app/api/projects/:id/memory/:entryId', async (c) => change(c, (await projectScope(c, true)).scope));
  app.delete('/app/api/projects/:id/memory/:entryId', async (c) => remove(c, (await projectScope(c, true)).scope));

  app.get('/app/api/me/memory', async (c) => list(c, personalScope(c), false));
  app.post('/app/api/me/memory', async (c) => add(c, personalScope(c)));
  app.put('/app/api/me/memory/:entryId', async (c) => change(c, personalScope(c)));
  app.delete('/app/api/me/memory/:entryId', async (c) => remove(c, personalScope(c)));
  // «Забыть всё»: the entries and what Mastra kept of the person before them.
  app.delete('/app/api/me/memory', async (c) => {
    const userId = access(c).userId;
    await forgetPersonal(db, userId);
    await forgetLegacyWorkingMemory(db, userId);
    return c.json({ ok: true });
  });
}
