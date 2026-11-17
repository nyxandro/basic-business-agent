// Memory of a project and of an employee kept as entries (spec, section 8.26) — the only place that reads and
// changes them. An entry is one short fact. People change an entry in the version they see on the page; an
// agent — in the version it saw at the start of its turn or in its own last result (SeenVersions), so it never
// overwrites a change made meanwhile. The agent may change and remove any entry, one a person made too
// (decision of the owner 17.11, F17-A). Who may see the memory of a project is decided by the caller through
// core/projects/access.ts; here a project only has to exist and not be in the archive.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';

export const PROJECT_MEMORY_MAX_CHARS = 6000;
export const PERSONAL_MEMORY_MAX_CHARS = 3000;
export const MEMORY_ENTRY_MAX_CHARS = 400;
// Operations in one call of the agent's tool.
export const MEMORY_OPERATIONS_MAX = 10;

export type MemoryScope = { kind: 'project'; projectId: string } | { kind: 'personal'; userId: string };

export interface MemoryActor {
  userId: string;
  byAgent: boolean;
}

export interface MemoryEntry {
  id: string;
  number: number;
  text: string;
  version: number;
  // Who changed it last; `id` and `name` are null once that person was removed from the installation.
  author: { id: string | null; name: string | null; byAgent: boolean };
  updatedAt: Date;
}

export interface MemoryList {
  entries: MemoryEntry[];
  usedChars: number;
  maxChars: number;
}

export type MemoryOperation = { action: 'add'; text: string } | { action: 'change'; number: number; text: string } | { action: 'remove'; number: number };

// Number of an entry → its version, as the agent saw it in this turn.
export type SeenVersions = Map<number, number>;

export interface OperationResult {
  action: MemoryOperation['action'];
  number: number;
  // The entry's text after the operation; of a removed one — what it was.
  text: string;
  previousText?: string;
  duplicate?: true;
}

export interface AgentOperationsResult {
  results: OperationResult[];
  usedChars: number;
  maxChars: number;
}

type Client = Pick<pg.PoolClient, 'query'>;

interface EntryRow {
  id: string;
  number: number;
  text: string;
  version: number;
  author_id: string | null;
  author_name: string | null;
  by_agent: boolean;
  updated_at: Date;
}

// Column names come from this fixed choice only, never from input.
function ownerOf(scope: MemoryScope): { column: 'project_id' | 'user_id'; value: string } {
  return scope.kind === 'project' ? { column: 'project_id', value: scope.projectId } : { column: 'user_id', value: scope.userId };
}

export function maxCharsOf(scope: MemoryScope): number {
  return scope.kind === 'project' ? PROJECT_MEMORY_MAX_CHARS : PERSONAL_MEMORY_MAX_CHARS;
}

const ENTRY_COLUMNS = `e.id, e.number, e.text, e.version, e.author_id, u."name" AS author_name, e.by_agent, e.updated_at`;

function toEntry(row: EntryRow): MemoryEntry {
  return { id: row.id, number: row.number, text: row.text, version: row.version, author: { id: row.author_id, name: row.author_name, byAgent: row.by_agent }, updatedAt: row.updated_at };
}

// One line in the prompt: spaces and line breaks become one space.
export function normaliseText(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text === '') throw appError('APP_VALIDATION_FAILED', 'empty memory entry', { userMessage: 'Запись не может быть пустой.' });
  const chars = [...text].length;
  if (chars > MEMORY_ENTRY_MAX_CHARS) throw appError('APP_MEMORY_ENTRY_TOO_LONG', `memory entry of ${chars} chars`, { details: { chars, maxChars: MEMORY_ENTRY_MAX_CHARS } });
  return text;
}

export async function listEntries(db: Db | Client, scope: MemoryScope): Promise<MemoryList> {
  const { column, value } = ownerOf(scope);
  const { rows } = await db.query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM app.memory_entries e LEFT JOIN app."user" u ON u."id" = e.author_id
      WHERE e.${column} = $1 ORDER BY e.updated_at DESC, e.number DESC`,
    [value],
  );
  const entries = rows.map(toEntry);
  return { entries, usedChars: entries.reduce((n, e) => n + [...e.text].length, 0), maxChars: maxCharsOf(scope) };
}

// The memory is changed by one transaction at a time: the counter's row is locked to its end. A project has to
// exist and be out of the archive (spec, 8.20: an archived project changes in nothing).
async function lockMemory(client: Client, scope: MemoryScope): Promise<void> {
  if (scope.kind === 'project') {
    const { rows } = await client.query<{ archived_at: Date | null }>('SELECT archived_at FROM app.projects WHERE id = $1 FOR SHARE', [scope.projectId]);
    if (!rows[0]) throw appError('APP_NOT_FOUND', `project ${scope.projectId} is gone`, { userMessage: 'Проект недоступен. Возможно, его удалили.' });
    if (rows[0].archived_at) throw appError('APP_PROJECT_ARCHIVED', `project ${scope.projectId} is archived: its memory is read only`);
  }
  const { column, value } = ownerOf(scope);
  await client.query(
    `INSERT INTO app.memory_counters (${column}) VALUES ($1)
       ON CONFLICT (${column}) WHERE ${column} IS NOT NULL DO UPDATE SET last_number = app.memory_counters.last_number`,
    [value],
  );
}

async function usedChars(client: Client, scope: MemoryScope): Promise<number> {
  const { column, value } = ownerOf(scope);
  const { rows } = await client.query<{ used: number }>(`SELECT coalesce(sum(char_length(text)), 0)::int AS used FROM app.memory_entries WHERE ${column} = $1`, [value]);
  return rows[0]!.used;
}

// The limit stops what makes a full memory bigger; what only frees the place always passes.
function checkLimit(scope: MemoryScope, before: number, after: number, operation?: number): void {
  const max = maxCharsOf(scope);
  if (after <= max || after <= before) return;
  throw appError('APP_MEMORY_FULL', `memory of ${scope.kind} would hold ${after} of ${max} chars`, {
    userMessage: scope.kind === 'project' ? 'Память проекта заполнена. Удалите устаревшие записи и попробуйте снова.' : 'Память заполнена. Удалите лишнее и попробуйте снова.',
    details: { usedChars: before, wouldBe: after, maxChars: max, ...(operation ? { operation } : {}) },
  });
}

async function entryBy(client: Client, scope: MemoryScope, by: { id: string } | { number: number }, lock: boolean): Promise<MemoryEntry | null> {
  const { column, value } = ownerOf(scope);
  const [field, key] = 'id' in by ? ['id', by.id] : ['number', by.number];
  const { rows } = await client.query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM app.memory_entries e LEFT JOIN app."user" u ON u."id" = e.author_id
      WHERE e.${column} = $1 AND e.${field} = $2${lock ? ' FOR UPDATE OF e' : ''}`,
    [value, key],
  );
  return rows[0] ? toEntry(rows[0]) : null;
}

async function insertEntry(client: Client, scope: MemoryScope, actor: MemoryActor, text: string): Promise<{ entry: MemoryEntry; duplicate: boolean }> {
  const { column, value } = ownerOf(scope);
  const same = await client.query<{ id: string }>(`SELECT id FROM app.memory_entries WHERE ${column} = $1 AND text = $2`, [value, text]);
  if (same.rows[0]) return { entry: (await entryBy(client, scope, { id: same.rows[0].id }, false))!, duplicate: true };
  const { rows } = await client.query<{ last_number: number }>(`UPDATE app.memory_counters SET last_number = last_number + 1 WHERE ${column} = $1 RETURNING last_number`, [value]);
  const id = randomUUID();
  await client.query(`INSERT INTO app.memory_entries (id, ${column}, number, text, author_id, by_agent) VALUES ($1, $2, $3, $4, $5, $6)`, [id, value, rows[0]!.last_number, text, actor.userId, actor.byAgent]);
  return { entry: (await entryBy(client, scope, { id }, false))!, duplicate: false };
}

async function updateEntry(client: Client, scope: MemoryScope, actor: MemoryActor, id: string, text: string): Promise<MemoryEntry> {
  await client.query('UPDATE app.memory_entries SET text = $2, version = version + 1, author_id = $3, by_agent = $4, updated_at = now() WHERE id = $1', [id, text, actor.userId, actor.byAgent]);
  return (await entryBy(client, scope, { id }, false))!;
}

const notFound = (scope: MemoryScope, key: string, details?: Record<string, unknown>) =>
  appError('APP_MEMORY_ENTRY_NOT_FOUND', `no memory entry ${key} in the ${scope.kind} memory`, details ? { details } : {});

// A person adds an entry on the page of a project or in «Моя память».
export async function addEntry(db: Db, scope: MemoryScope, actor: MemoryActor, raw: string): Promise<MemoryEntry> {
  const text = normaliseText(raw);
  return inTransaction(db, async (client) => {
    await lockMemory(client, scope);
    const before = await usedChars(client, scope);
    const { entry, duplicate } = await insertEntry(client, scope, actor, text);
    if (duplicate) throw appError('APP_MEMORY_DUPLICATE', `memory entry ${entry.number} has the same text`, { details: { entry } });
    checkLimit(scope, before, await usedChars(client, scope));
    return entry;
  });
}

// A person changes an entry in the version they saw; another version is a conflict with what is there now.
export async function changeEntry(db: Db, scope: MemoryScope, actor: MemoryActor, entryId: string, raw: string, version: number): Promise<MemoryEntry> {
  const text = normaliseText(raw);
  return inTransaction(db, async (client) => {
    await lockMemory(client, scope);
    const current = await entryBy(client, scope, { id: entryId }, true);
    if (!current) throw notFound(scope, entryId);
    if (current.version !== version) throw appError('APP_MEMORY_CONFLICT', `memory entry ${entryId} is in version ${current.version}, not ${version}`, { details: { entry: current } });
    const before = await usedChars(client, scope);
    const entry = await updateEntry(client, scope, actor, entryId, text);
    checkLimit(scope, before, await usedChars(client, scope));
    return entry;
  });
}

// Gives back the removed entry: «Вернуть» adds its text anew.
export async function removeEntry(db: Db, scope: MemoryScope, entryId: string): Promise<MemoryEntry> {
  return inTransaction(db, async (client) => {
    await lockMemory(client, scope);
    const current = await entryBy(client, scope, { id: entryId }, true);
    if (!current) throw notFound(scope, entryId);
    await client.query('DELETE FROM app.memory_entries WHERE id = $1', [entryId]);
    return current;
  });
}

// «Забыть всё» of «Моя память».
export async function forgetPersonal(db: Db, userId: string): Promise<void> {
  await db.query('DELETE FROM app.memory_entries WHERE user_id = $1', [userId]);
}

// The agent's tool: the operations of one call go in order and as a whole — a failed one leaves none of them.
// `seen` is updated only after the call is saved.
export async function applyAgentOperations(db: Db, scope: MemoryScope, actor: MemoryActor, operations: MemoryOperation[], seen: SeenVersions): Promise<AgentOperationsResult> {
  if (operations.length === 0 || operations.length > MEMORY_OPERATIONS_MAX) {
    throw appError('APP_VALIDATION_FAILED', `${operations.length} memory operations in one call`, { userMessage: `За один вызов — от 1 до ${MEMORY_OPERATIONS_MAX} операций.` });
  }
  const texts = operations.map((op, i) => {
    if (op.action === 'remove') return null;
    try {
      return normaliseText(op.text);
    } catch (error) {
      throw Object.assign(error as Error, { details: { ...((error as { details?: object }).details ?? {}), operation: i + 1 } });
    }
  });
  const known = new Map(seen);
  const saved = await inTransaction(db, async (client) => {
    await lockMemory(client, scope);
    const before = await usedChars(client, scope);
    const results: OperationResult[] = [];
    for (const [i, op] of operations.entries()) {
      const operation = i + 1;
      if (op.action === 'add') {
        const { entry, duplicate } = await insertEntry(client, scope, actor, texts[i]!);
        known.set(entry.number, entry.version);
        results.push({ action: 'add', number: entry.number, text: entry.text, ...(duplicate ? { duplicate: true as const } : {}) });
        continue;
      }
      const current = await entryBy(client, scope, { number: op.number }, true);
      if (!current) throw notFound(scope, `№${op.number}`, { operation, number: op.number });
      if (known.get(op.number) !== current.version) {
        throw appError('APP_MEMORY_CONFLICT', `memory entry №${op.number} changed after the agent saw it`, { details: { operation, number: op.number, text: current.text, version: current.version } });
      }
      if (op.action === 'change') {
        const entry = await updateEntry(client, scope, actor, current.id, texts[i]!);
        known.set(entry.number, entry.version);
        results.push({ action: 'change', number: entry.number, text: entry.text, previousText: current.text });
      } else {
        await client.query('DELETE FROM app.memory_entries WHERE id = $1', [current.id]);
        known.delete(op.number);
        results.push({ action: 'remove', number: op.number, text: current.text });
      }
    }
    const after = await usedChars(client, scope);
    checkLimit(scope, before, after, operations.findIndex((op) => op.action !== 'remove') + 1);
    return { results, usedChars: after, maxChars: maxCharsOf(scope) };
  });
  seen.clear();
  for (const [number, version] of known) seen.set(number, version);
  return saved;
}
