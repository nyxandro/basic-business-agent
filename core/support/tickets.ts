// Tickets of «Поддержка» (docs/specs/[20.11.2026]-feedback-and-value.md, scenarios 1 and 2; owner 21.11, F1 and F5; 24.11,
// F7–F9): a complaint about an answer — its comment the first message, with a copy of the conversation and its files for
// the support — or a request written straight (requests.ts). Inside, a conversation of both sides (messages.ts). Read by
// the people with «Агенты»; the employee sees only their own. A second complaint about the same turn is a new message of
// the first.
import type { AdminTicketDto, AdminTicketRow, ComplaintResponse, MyTicketDto, MyTicketRow, SupportFileDto, SupportKind, SupportMessageDto, SupportSide, SupportSnapshotMessage, SupportStatus } from '@bba/contracts';
import type { Memory } from '@mastra/memory';
import type { AccessContext } from '../auth/access.ts';
import { inThreadFolder, threadFoldersOf } from '../chat/thread-folder.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { conversationMessages, conversationsByIds } from '../history/store.ts';
import { logEvent } from '../log/log.ts';
import type { FileStorage } from '../storage/engine.ts';
import { employeeWrites, insertMessage, tellAfterSave, tellSupport } from './messages.ts';
import { copyFiles, filesOfConversation, snapshotOf } from './snapshot.ts';

const TICKETS_SHOWN = 200;

export interface SupportDeps {
  db: Db;
  memory: Memory;
  storage: Pick<FileStorage, 'hold'>;
  workspaceRoot: string;
  timezone: string;
  agentName: (agentId: string) => string;
}

// The task of a conversation of a background task (`bg:<task>:<person>[:<event>]`).
const taskOfThread = (threadId: string): string | null => (threadId.startsWith('bg:') ? (threadId.split(':')[1] ?? null) : null);

interface TicketRow {
  id: string;
  user_id: string | null;
  author: string | null;
  kind: SupportKind;
  subject: string | null;
  // A request has no agent, conversation or turn.
  agent_id: string | null;
  thread_id: string | null;
  turn_key: number | null;
  task_id: string | null;
  snapshot: SupportSnapshotMessage[];
  models: string[];
  instructions_at: Date | null;
  status: SupportStatus;
  closed_side: SupportSide | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function existingComplaint(db: Db, userId: string, threadId: string, turn: number): Promise<{ id: string; status: SupportStatus } | null> {
  const { rows } = await db.query<{ id: string; status: SupportStatus }>('SELECT id::text, status FROM app.support_tickets WHERE user_id = $1 AND thread_id = $2 AND turn_key = $3', [userId, threadId, turn]);
  return rows[0] ?? null;
}

// A second complaint about the same turn: a message of the first, which opens again if it was closed.
async function append(deps: SupportDeps, userId: string, ticketId: string, comment: string): Promise<ComplaintResponse> {
  await employeeWrites(deps.db, userId, ticketId, comment, [], { reopen: true });
  logEvent('info', 'support_ticket_appended', { ticketId });
  return { id: ticketId, appended: true };
}

export async function complain(deps: SupportDeps, userId: string, input: { threadId: string; turn: number; comment: string }): Promise<ComplaintResponse> {
  const { db } = deps;
  const [conversation] = await conversationsByIds(db, userId, [input.threadId]);
  if (!conversation) throw appError('APP_NOT_FOUND', `thread ${input.threadId} is not a conversation of ${userId}`, { userMessage: 'Разговор не найден.' });
  const before = await existingComplaint(db, userId, input.threadId, input.turn);
  if (before) return append(deps, userId, before.id, input.comment);

  const { messages, approvals } = await conversationMessages(db, userId, input.threadId);
  const snapshot = snapshotOf(messages, approvals);
  const span = snapshot.span(input.turn);
  if (!span) throw appError('APP_VALIDATION_FAILED', `turn ${input.turn} of ${snapshot.turns} in ${input.threadId}`, { userMessage: 'Этого ответа в разговоре уже нет. Обновите страницу.' });
  // Files of a project come from its folder: the person sees the project now, or the files are their own.
  const found = await threadFoldersOf(deps, userId, input.threadId);
  const files = await inThreadFolder(deps.storage, found, 'read', (folder) => copyFiles(folder, filesOfConversation(messages)));
  const [models, instructions] = await Promise.all([
    db.query<{ model: string }>(
      `SELECT DISTINCT model FROM app.usage_events WHERE user_id = $1 AND agent_id = $2 AND at >= $3 AND ($4::timestamptz IS NULL OR at < $4) ORDER BY model`,
      [userId, conversation.agentId, span.from, span.to],
    ),
    db.query<{ published_at: Date | null }>('SELECT published_at FROM app.agent_overrides WHERE agent_id = $1', [conversation.agentId]),
  ]);

  const id = await inTransaction(db, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.support_tickets (user_id, kind, agent_id, thread_id, turn_key, task_id, snapshot, models, instructions_at, status)
       VALUES ($1, 'complaint', $2, $3, $4, $5, $6, $7, $8, 'open')
       ON CONFLICT (user_id, thread_id, turn_key) WHERE user_id IS NOT NULL DO NOTHING RETURNING id::text`,
      [userId, conversation.agentId, input.threadId, input.turn, taskOfThread(input.threadId), JSON.stringify(snapshot.messages), models.rows.map((r) => r.model), instructions.rows[0]?.published_at ?? null],
    );
    const ticketId = rows[0]?.id;
    if (!ticketId) return null;
    // The files of the conversation, for the support: they belong to no message.
    for (const [ord, f] of files.entries()) {
      await c.query('INSERT INTO app.support_files (ticket_id, ord, name, path, size, state, content) VALUES ($1, $2, $3, $4, $5, $6, $7)', [ticketId, ord, f.name, f.path, f.size, f.state, f.content]);
    }
    await insertMessage(c, ticketId, 'employee', userId, input.comment, []);
    return ticketId;
  });
  // Two presses at once: the other one made the ticket — this comment adds to it.
  if (!id) {
    const made = await existingComplaint(db, userId, input.threadId, input.turn);
    if (!made) throw appError('APP_SUPPORT_FAILED', `complaint about turn ${input.turn} of ${input.threadId} neither made nor found`);
    return append(deps, userId, made.id, input.comment);
  }
  logEvent('info', 'support_ticket_created', { ticketId: id, agentId: conversation.agentId, files: files.length });
  await tellAfterSave(db, id, () => tellSupport(db, id, userId, { complaintOf: deps.agentName(conversation.agentId) }));
  return { id, appended: false };
}

const ROW_SQL = `SELECT t.id::text, t.user_id, u."name" AS author, t.kind, t.subject, t.agent_id, t.thread_id, t.turn_key, t.task_id, t.snapshot,
                        t.models, t.instructions_at, t.status, t.closed_side, t.closed_at, t.created_at, t.updated_at
                   FROM app.support_tickets t LEFT JOIN app."user" u ON u."id" = t.user_id`;

type Named = Pick<SupportDeps, 'db' | 'agentName'>;

const myRowOf = (deps: Pick<SupportDeps, 'agentName'>, r: TicketRow): MyTicketRow => ({
  id: r.id,
  kind: r.kind,
  subject: r.subject,
  agentName: r.agent_id === null ? null : deps.agentName(r.agent_id),
  status: r.status,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const adminRowOf = (deps: Pick<SupportDeps, 'agentName'>, r: TicketRow): AdminTicketRow => ({ ...myRowOf(deps, r), author: r.author, agentId: r.agent_id });

const closingOf = (r: TicketRow) => ({ closedAt: r.closed_at?.toISOString() ?? null, closedSide: r.closed_side });

export async function myTickets(deps: Named, userId: string): Promise<MyTicketRow[]> {
  const { rows } = await deps.db.query<TicketRow>(`${ROW_SQL} WHERE t.user_id = $1 ORDER BY t.updated_at DESC LIMIT ${TICKETS_SHOWN}`, [userId]);
  return rows.map((r) => myRowOf(deps, r));
}

export async function listTickets(deps: Named, status: SupportStatus | null): Promise<AdminTicketRow[]> {
  const { rows } = await deps.db.query<TicketRow>(`${ROW_SQL} WHERE ($1::text IS NULL OR t.status = $1) ORDER BY t.updated_at DESC LIMIT ${TICKETS_SHOWN}`, [status]);
  return rows.map((r) => adminRowOf(deps, r));
}

const notFound = (id: string) => appError('APP_NOT_FOUND', `ticket ${id} not found`, { userMessage: 'Обращение не найдено.' });

// `ownerId` — only a ticket of this person: another one's is as missing as none.
async function ticketRow(db: Db, id: string, ownerId: string | null): Promise<TicketRow> {
  if (!/^\d{1,18}$/.test(id)) throw notFound(id);
  const { rows } = await db.query<TicketRow>(`${ROW_SQL} WHERE t.id = $1 AND ($2::text IS NULL OR t.user_id = $2)`, [id, ownerId]);
  if (!rows[0]) throw notFound(id);
  return rows[0];
}

interface FileRow {
  ord: number;
  name: string;
  size: string | null;
  state: SupportFileDto['state'];
  message_id: string | null;
}

const fileOf = (f: FileRow): SupportFileDto => ({ ord: f.ord, name: f.name, size: f.size === null ? null : Number(f.size), state: f.state });

// The conversation of a ticket, each message with its files; and the files of the complained conversation apart.
async function conversationOf(db: Db, id: string): Promise<{ messages: SupportMessageDto[]; contextFiles: SupportFileDto[] }> {
  const [messages, files] = await Promise.all([
    db.query<{ id: string; side: SupportSide; author: string | null; text: string; created_at: Date }>(
      `SELECT m.id::text, m.side, u."name" AS author, m.text, m.created_at FROM app.support_messages m LEFT JOIN app."user" u ON u."id" = m.author_id WHERE m.ticket_id = $1 ORDER BY m.id`,
      [id],
    ),
    db.query<FileRow>('SELECT ord, name, size, state, message_id::text FROM app.support_files WHERE ticket_id = $1 ORDER BY ord', [id]),
  ]);
  const byMessage = new Map<string, SupportFileDto[]>();
  for (const f of files.rows) if (f.message_id) byMessage.set(f.message_id, [...(byMessage.get(f.message_id) ?? []), fileOf(f)]);
  return {
    messages: messages.rows.map((m) => ({ id: m.id, side: m.side, author: m.author, text: m.text, at: m.created_at.toISOString(), files: byMessage.get(m.id) ?? [] })),
    contextFiles: files.rows.filter((f) => !f.message_id).map(fileOf),
  };
}

export async function myTicket(deps: Named, userId: string, id: string): Promise<MyTicketDto> {
  const r = await ticketRow(deps.db, id, userId);
  const { messages } = await conversationOf(deps.db, id);
  return { ...myRowOf(deps, r), ...closingOf(r), messages };
}

export async function ticketDetail(deps: Named, id: string): Promise<AdminTicketDto> {
  const r = await ticketRow(deps.db, id, null);
  const { messages, contextFiles } = await conversationOf(deps.db, id);
  return {
    ...adminRowOf(deps, r),
    ...closingOf(r),
    messages,
    turn: r.turn_key,
    snapshot: r.snapshot,
    contextFiles,
    models: r.models,
    instructionsAt: r.instructions_at?.toISOString() ?? null,
    taskId: r.task_id,
  };
}

// A file of a ticket for the support: any it keeps.
export async function ticketFile(db: Db, id: string, ord: number): Promise<{ name: string; content: Buffer }> {
  await ticketRow(db, id, null);
  const { rows } = await db.query<{ name: string; content: Buffer | null }>('SELECT name, content FROM app.support_files WHERE ticket_id = $1 AND ord = $2', [id, ord]);
  if (!rows[0]?.content) throw appError('APP_NOT_FOUND', `file ${ord} of ticket ${id} not copied`, { userMessage: 'Этот файл не приложен к обращению.' });
  return { name: rows[0].name, content: rows[0].content };
}

// A file of a ticket for its employee: only one attached to a message — the copies of a complained conversation are the
// support's.
export async function myTicketFile(db: Db, userId: string, id: string, ord: number): Promise<{ name: string; content: Buffer }> {
  await ticketRow(db, id, userId);
  const { rows } = await db.query<{ name: string; content: Buffer | null }>('SELECT name, content FROM app.support_files WHERE ticket_id = $1 AND ord = $2 AND message_id IS NOT NULL', [id, ord]);
  if (!rows[0]?.content) throw appError('APP_NOT_FOUND', `file ${ord} of ticket ${id} is not a file of its messages`, { userMessage: 'Этот файл не приложен к обращению.' });
  return { name: rows[0].name, content: rows[0].content };
}

// The red counter of «Поддержка» in the menu of the admin panel (owner 24.11, F8–F9): the tickets waiting for the
// support's answer, for those who handle them (F5); null for the others.
export async function waitingTicketsFor(db: Db, who: Pick<AccessContext, 'isSuperadmin' | 'permissions'>): Promise<number | null> {
  if (!who.isSuperadmin && !who.permissions.has('agents')) return null;
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM app.support_tickets WHERE status = 'open'");
  if (!rows[0]) throw new Error('count of waiting tickets returned no row');
  return rows[0].n;
}
