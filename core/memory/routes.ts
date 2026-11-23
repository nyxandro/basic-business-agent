// «Моя память» (spec, section 8.26): the personal memory is the employee's own. The memory of a project has its
// routes in core/projects/memory-routes.ts, next to the rule of who sees the project; both use the handlers here.
import { memoryEntryChangeSchema, memoryEntryInputSchema, type MemoryEntryDto, type MemoryListDto } from '@bba/contracts';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { access, parseJson, type AppEnv } from '../http/http.ts';
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

// Reading and changing the entries of one memory — of a project or of a person — over HTTP.
export function memoryEntryHandlers(db: Db) {
  const actorOf = (c: Context<AppEnv>) => ({ userId: access(c).userId, byAgent: false });
  return {
    list: async (c: Context<AppEnv>, scope: MemoryScope, readOnly: boolean): Promise<Response> => {
      const memory = await listEntries(db, scope);
      const body: MemoryListDto = { entries: memory.entries.map((e) => entryDto(e, access(c).userId)), usedChars: memory.usedChars, maxChars: memory.maxChars, readOnly };
      return c.json(body);
    },
    add: async (c: Context<AppEnv>, scope: MemoryScope): Promise<Response> => {
      const { text } = await parseJson(c, memoryEntryInputSchema);
      return c.json(entryDto(await addEntry(db, scope, actorOf(c), text), access(c).userId));
    },
    change: async (c: Context<AppEnv>, scope: MemoryScope): Promise<Response> => {
      const id = entryIdOf(c);
      const { text, version } = await parseJson(c, memoryEntryChangeSchema);
      return c.json(entryDto(await changeEntry(db, scope, actorOf(c), id, text, version), access(c).userId));
    },
    remove: async (c: Context<AppEnv>, scope: MemoryScope): Promise<Response> => {
      return c.json(entryDto(await removeEntry(db, scope, entryIdOf(c)), access(c).userId));
    },
  };
}

export function registerMemoryRoutes(app: Hono<AppEnv>, deps: MemoryRoutesDeps): void {
  const { db } = deps;
  const { list, add, change, remove } = memoryEntryHandlers(db);
  const personalScope = (c: Context<AppEnv>): MemoryScope => ({ kind: 'personal', userId: access(c).userId });

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
