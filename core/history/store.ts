// The person's own conversations as the agent sees them (spec, section 8.28): the list, one conversation by
// its number, its stored messages with the requests for «Да» of its actions. Every query asks for the person's
// own conversations (`"resourceId" = userId`) — there is no way to a conversation by its number alone: a
// colleague's conversation in a project open to the whole department is never found, and its number reads
// as one that is not there. Mastra's tables are read directly, as «Поиск» reads them (core/search).
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { SEES } from '../projects/access.ts';
import type { ApprovalOutcome } from './transcript.ts';

// The short number of a conversation: the first characters of its id.
export const REF_LENGTH = 8;
export const refOf = (id: string) => id.slice(0, REF_LENGTH);

export type ProjectPlace =
  | { state: 'none' }
  | { state: 'active'; name: string }
  | { state: 'archived'; name: string }
  | { state: 'access'; name: string }
  | { state: 'deleted'; name: string };

export interface ConversationRow {
  id: string;
  title: string;
  agentId: string;
  kind: 'chat' | 'background';
  started: Date;
  last: Date;
  // Messages with something the person saw (non-empty rows of app.message_texts).
  messages: number;
  project: ProjectPlace;
}

interface Row {
  id: string;
  title: string;
  agent_id: string | null;
  kind: string;
  started: Date;
  last: Date;
  messages: string;
  project_id: string | null;
  lost_project_name: string | null;
  project_name: string | null;
  archived: boolean | null;
  sees: boolean | null;
}

// $1 — the person. The project of each conversation as the person sees it now (spec, 8.20): a link to a
// project removed for good keeps only its name, and only for colleagues of its creator.
const ROWS = `
  SELECT t.id, t.title, t.metadata->>'agentId' AS agent_id, COALESCE(t.metadata->>'kind', 'chat') AS kind,
         t."createdAtZ" AS started, t."updatedAtZ" AS last,
         (SELECT count(*) FROM app.message_texts mt WHERE mt.thread_id = t.id AND btrim(mt.text) <> '') AS messages,
         tp.project_id, tp.lost_project_name, p.name AS project_name, p.archived_at IS NOT NULL AS archived, ${SEES} AS sees
    FROM mastra.mastra_threads t
    LEFT JOIN app.thread_projects tp ON tp.thread_id = t.id AND tp.user_id = $1
    LEFT JOIN app.projects p ON p.id = tp.project_id
   WHERE t."resourceId" = $1 AND COALESCE(t.metadata->>'kind', 'chat') <> 'draft'`;

function placeOf(row: Row): ProjectPlace {
  if (row.project_name !== null) {
    if (row.archived) return { state: 'archived', name: row.project_name };
    return row.sees ? { state: 'active', name: row.project_name } : { state: 'access', name: row.project_name };
  }
  return row.lost_project_name ? { state: 'deleted', name: row.lost_project_name } : { state: 'none' };
}

function conversationOf(row: Row): ConversationRow {
  // Every conversation is made by ensureThread with its agent: one without is broken data.
  if (!row.agent_id) throw new Error(`thread ${row.id} has no agentId in its metadata`);
  return {
    id: row.id,
    title: row.title,
    agentId: row.agent_id,
    kind: row.kind === 'background' ? 'background' : 'chat',
    started: row.started,
    last: row.last,
    messages: Number(row.messages),
    project: placeOf(row),
  };
}

// The person's conversations, newest first: of one project (`projectId`) or all; `exclude` — the current one.
export async function listConversations(db: Db, userId: string, opts: { projectId: string | null; exclude: string | null; limit: number; offset: number }): Promise<{ rows: ConversationRow[]; total: number }> {
  const params = [userId, opts.exclude ?? '', opts.projectId];
  const which = `AND t.id <> $2 AND ($3::uuid IS NULL OR tp.project_id = $3::uuid)`;
  // Counted on its own: a page past the end has no rows to count with, and the person still has conversations.
  const [page, counted] = await Promise.all([
    db.query<Row>(`${ROWS} ${which} ORDER BY t."updatedAtZ" DESC, t.id DESC LIMIT $4 OFFSET $5`, [...params, opts.limit, opts.offset]),
    db.query<{ n: string }>(
      `SELECT count(*) AS n FROM mastra.mastra_threads t LEFT JOIN app.thread_projects tp ON tp.thread_id = t.id AND tp.user_id = $1
        WHERE t."resourceId" = $1 AND COALESCE(t.metadata->>'kind', 'chat') <> 'draft' ${which}`,
      params,
    ),
  ]);
  return { rows: page.rows.map(conversationOf), total: Number(counted.rows[0]!.n) };
}

// The person's conversations among `ids` (the found ones of a search), in no particular order.
export async function conversationsByIds(db: Db, userId: string, ids: string[]): Promise<ConversationRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<Row>(`${ROWS} AND t.id = ANY($2::text[])`, [userId, ids]);
  return rows.map(conversationOf);
}

const notFound = (ref: string) =>
  appError('APP_NOT_FOUND', `conversation ${ref} not found for the user`, { userMessage: `Разговор ${ref} не найден: его нет или он не этого сотрудника. Посмотри list или search.` });

// One own conversation by its full id or its short number. A number of a colleague's conversation is not
// found the same way as one that is not there at all.
export async function resolveConversation(db: Db, userId: string, ref: string): Promise<ConversationRow> {
  const wanted = ref.trim();
  // A shorter number is only the whole id: a few characters would fit dozens of conversations.
  const { rows } = await db.query<Row>(`${ROWS} AND (t.id = $2 OR (length($2) >= ${REF_LENGTH} AND left(t.id, length($2)) = $2)) ORDER BY t."updatedAtZ" DESC LIMIT 11`, [userId, wanted]);
  const exact = rows.find((r) => r.id === wanted);
  if (exact) return conversationOf(exact);
  if (rows.length === 0) throw notFound(wanted);
  if (rows.length > 1) {
    const which = rows.slice(0, 10).map((r) => `«${r.title}» (${r.id})`).join(', ');
    throw appError('APP_VALIDATION_FAILED', `conversation number ${wanted} fits ${rows.length} conversations`, { userMessage: `Номеру ${wanted} подходят разговоры: ${which} — укажи полный номер.` });
  }
  return conversationOf(rows[0]!);
}

export interface StoredMessage {
  // The place among all stored messages of the conversation, the same as the search gives (core/search).
  number: number;
  role: 'user' | 'assistant';
  createdAt: Date;
  content: string;
}

// The stored messages of a conversation already found as the person's own, and how the actions in it that
// waited for «Да» were decided.
export async function conversationMessages(db: Db, userId: string, threadId: string): Promise<{ messages: StoredMessage[]; approvals: Map<string, ApprovalOutcome> }> {
  const [messages, approvals] = await Promise.all([
    db.query<{ number: string; role: string; created: Date; content: string }>(
      `SELECT row_number() OVER (ORDER BY m."createdAt", m.id) AS number, m.role, COALESCE(m."createdAtZ", m."createdAt" AT TIME ZONE 'UTC') AS created, m.content
         FROM mastra.mastra_messages m JOIN mastra.mastra_threads t ON t.id = m.thread_id
        WHERE m.thread_id = $2 AND t."resourceId" = $1
        ORDER BY m."createdAt", m.id`,
      [userId, threadId],
    ),
    // A question of a chat nobody answered in time stays «pending» in the table — only a press finds it out of
    // date (core/chat/run.ts) —, so it reads as expired here. Requests are unique per run and call: should a
    // provider repeat a call's id in another turn, the later request wins.
    db.query<{ tool_call_id: string; status: ApprovalOutcome['status']; error_code: string | null; summary: string }>(
      `SELECT tool_call_id, CASE WHEN status = 'pending' AND expires_at < now() THEN 'expired' ELSE status END AS status, error_code, summary
         FROM app.approval_requests WHERE thread_id = $2 AND user_id = $1 ORDER BY created_at, id`,
      [userId, threadId],
    ),
  ]);
  return {
    messages: messages.rows
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ number: Number(m.number), role: m.role as 'user' | 'assistant', createdAt: m.created, content: m.content })),
    approvals: new Map(approvals.rows.map((a) => [a.tool_call_id, { status: a.status, errorCode: a.error_code, summary: a.summary }])),
  };
}

// How many messages of a conversation are stored: Mastra gives the model only the last LAST_MESSAGES.
export async function storedMessageCount(db: Db, threadId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM mastra.mastra_messages WHERE thread_id = $1', [threadId]);
  return Number(rows[0]!.n);
}
