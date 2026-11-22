// Complaints about answers (docs/specs/[20.11.2026]-feedback-and-value.md, scenarios 1 and 2; owner 21.11, F1 and F5):
// the employee's comment with a copy of the conversation and its files becomes a ticket of «Поддержка», read by the
// people with «Агенты»; the answer and the state go back to the employee as a notification and «Мои обращения».
// A second complaint about the same turn adds to the first.
import type { AdminTicketDto, AdminTicketRow, ComplaintResponse, MyTicketDto, SupportFileDto, SupportSnapshotMessage, SupportStatus } from '@bba/contracts';
import type { Memory } from '@mastra/memory';
import { writeAudit } from '../audit/audit.ts';
import { holdersOf } from '../auth/holders.ts';
import { inThreadFolder, threadFoldersOf } from '../chat/thread-folder.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { conversationMessages, conversationsByIds } from '../history/store.ts';
import { notices } from '../notifications/kinds.ts';
import { notify } from '../notifications/notify.ts';
import { logEvent } from '../server/log.ts';
import type { FileStorage } from '../storage/engine.ts';
import { copyFiles, filesOfConversation, snapshotOf } from './snapshot.ts';

const COMMENT_MAX = 8000;
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
  agent_id: string;
  thread_id: string;
  turn_key: number;
  task_id: string | null;
  comment: string;
  snapshot: SupportSnapshotMessage[];
  models: string[];
  instructions_at: Date | null;
  status: SupportStatus;
  reply: string | null;
  handler: string | null;
  created_at: Date;
  updated_at: Date;
}

const stamp = (at: Date, timeZone: string) => at.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone });

async function tellSupport(deps: SupportDeps, ticketId: string, agentId: string, appendedAt: Date | null): Promise<void> {
  for (const userId of await holdersOf(deps.db, 'agents')) await notify(deps.db, notices.supportNew({ userId, ticketId, agentName: deps.agentName(agentId), appendedAt }));
}

// Adds the comment to the complaint about the same turn; a closed one opens again for the support to see it.
async function append(deps: SupportDeps, ticketId: string, agentId: string, comment: string): Promise<ComplaintResponse> {
  const at = new Date();
  const { rows } = await deps.db.query<{ length: number }>(
    `UPDATE app.support_tickets SET comment = comment || $2, updated_at = $3,
            status = CASE WHEN status IN ('resolved', 'rejected') THEN 'new' ELSE status END
      WHERE id = $1 AND length(comment || $2) <= ${COMMENT_MAX} RETURNING length(comment) AS length`,
    [ticketId, `\n\nДописано ${stamp(at, deps.timezone)}: ${comment}`, at],
  );
  if (!rows[0]) throw appError('APP_SUPPORT_TOO_LONG', `complaint ${ticketId} would grow over ${COMMENT_MAX} characters`);
  await tellSupport(deps, ticketId, agentId, at);
  logEvent('info', 'support_ticket_appended', { ticketId });
  return { id: ticketId, appended: true };
}

export async function existingComplaint(db: Db, userId: string, threadId: string, turn: number): Promise<{ id: string; status: SupportStatus } | null> {
  const { rows } = await db.query<{ id: string; status: SupportStatus }>('SELECT id::text, status FROM app.support_tickets WHERE user_id = $1 AND thread_id = $2 AND turn_key = $3', [userId, threadId, turn]);
  return rows[0] ?? null;
}

export async function complain(deps: SupportDeps, userId: string, input: { threadId: string; turn: number; comment: string }): Promise<ComplaintResponse> {
  const { db } = deps;
  const [conversation] = await conversationsByIds(db, userId, [input.threadId]);
  if (!conversation) throw appError('APP_NOT_FOUND', `thread ${input.threadId} is not a conversation of ${userId}`, { userMessage: 'Разговор не найден.' });
  const before = await existingComplaint(db, userId, input.threadId, input.turn);
  if (before) return append(deps, before.id, conversation.agentId, input.comment);

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
      `INSERT INTO app.support_tickets (user_id, agent_id, thread_id, turn_key, task_id, comment, snapshot, models, instructions_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'new')
       ON CONFLICT (user_id, thread_id, turn_key) WHERE user_id IS NOT NULL DO NOTHING RETURNING id::text`,
      [userId, conversation.agentId, input.threadId, input.turn, taskOfThread(input.threadId), input.comment, JSON.stringify(snapshot.messages), models.rows.map((r) => r.model), instructions.rows[0]?.published_at ?? null],
    );
    const ticketId = rows[0]?.id;
    if (!ticketId) return null;
    for (const [ord, f] of files.entries()) {
      await c.query('INSERT INTO app.support_files (ticket_id, ord, name, path, size, state, content) VALUES ($1, $2, $3, $4, $5, $6, $7)', [ticketId, ord, f.name, f.path, f.size, f.state, f.content]);
    }
    return ticketId;
  });
  // Two presses at once: the other one made the ticket — this comment adds to it.
  if (!id) {
    const made = await existingComplaint(db, userId, input.threadId, input.turn);
    if (!made) throw appError('APP_SUPPORT_FAILED', `complaint about turn ${input.turn} of ${input.threadId} neither made nor found`);
    return append(deps, made.id, conversation.agentId, input.comment);
  }
  logEvent('info', 'support_ticket_created', { ticketId: id, agentId: conversation.agentId, files: files.length });
  await tellSupport(deps, id, conversation.agentId, null);
  return { id, appended: false };
}

const ROW_SQL = `SELECT t.id::text, t.user_id, u."name" AS author, t.agent_id, t.thread_id, t.turn_key, t.task_id, t.comment, t.snapshot, t.models,
                        t.instructions_at, t.status, t.reply, h."name" AS handler, t.created_at, t.updated_at
                   FROM app.support_tickets t LEFT JOIN app."user" u ON u."id" = t.user_id LEFT JOIN app."user" h ON h."id" = t.handled_by`;

const rowOf = (deps: Pick<SupportDeps, 'agentName'>, r: TicketRow): AdminTicketRow => ({
  id: r.id,
  author: r.author,
  agentId: r.agent_id,
  agentName: deps.agentName(r.agent_id),
  status: r.status,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export async function myTickets(deps: Pick<SupportDeps, 'db' | 'agentName'>, userId: string): Promise<MyTicketDto[]> {
  const { rows } = await deps.db.query<TicketRow>(`${ROW_SQL} WHERE t.user_id = $1 ORDER BY t.created_at DESC LIMIT ${TICKETS_SHOWN}`, [userId]);
  return rows.map((r) => ({ id: r.id, agentName: deps.agentName(r.agent_id), status: r.status, comment: r.comment, reply: r.reply, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() }));
}

export async function listTickets(deps: Pick<SupportDeps, 'db' | 'agentName'>, status: SupportStatus | null): Promise<AdminTicketRow[]> {
  const { rows } = await deps.db.query<TicketRow>(`${ROW_SQL} WHERE ($1::text IS NULL OR t.status = $1) ORDER BY t.created_at DESC LIMIT ${TICKETS_SHOWN}`, [status]);
  return rows.map((r) => rowOf(deps, r));
}

async function ticketRow(db: Db, id: string): Promise<TicketRow> {
  if (!/^\d{1,18}$/.test(id)) throw appError('APP_NOT_FOUND', `ticket ${id} not found`, { userMessage: 'Обращение не найдено.' });
  const { rows } = await db.query<TicketRow>(`${ROW_SQL} WHERE t.id = $1`, [id]);
  if (!rows[0]) throw appError('APP_NOT_FOUND', `ticket ${id} not found`, { userMessage: 'Обращение не найдено.' });
  return rows[0];
}

export async function ticketDetail(deps: Pick<SupportDeps, 'db' | 'agentName'>, id: string): Promise<AdminTicketDto> {
  const r = await ticketRow(deps.db, id);
  const files = await deps.db.query<{ ord: number; name: string; size: string | null; state: SupportFileDto['state'] }>('SELECT ord, name, size, state FROM app.support_files WHERE ticket_id = $1 ORDER BY ord', [id]);
  return {
    ...rowOf(deps, r),
    comment: r.comment,
    turn: r.turn_key,
    snapshot: r.snapshot,
    files: files.rows.map((f) => ({ ord: f.ord, name: f.name, size: f.size === null ? null : Number(f.size), state: f.state })),
    models: r.models,
    instructionsAt: r.instructions_at?.toISOString() ?? null,
    taskId: r.task_id,
    reply: r.reply,
    handledBy: r.handler,
  };
}

// The states a ticket goes to from each (section 17): a closed one only opens again («Открыть снова»).
const NEXT: Record<SupportStatus, readonly SupportStatus[]> = {
  new: ['new', 'in_progress', 'resolved', 'rejected'],
  in_progress: ['in_progress', 'resolved', 'rejected'],
  resolved: ['resolved', 'in_progress'],
  rejected: ['rejected', 'in_progress'],
};

export async function updateTicket(deps: Pick<SupportDeps, 'db' | 'agentName'>, actorUserId: string, id: string, change: { status: SupportStatus; reply: string | null }): Promise<AdminTicketDto> {
  const { db } = deps;
  const before = await ticketRow(db, id);
  if (!NEXT[before.status].includes(change.status)) throw appError('APP_SUPPORT_STATE', `ticket ${id}: ${before.status} → ${change.status}`);
  const reply = change.reply === '' ? null : change.reply;
  const at = new Date();
  await inTransaction(db, async (c) => {
    // Only the state the page showed is changed: two admins answering at once do not overwrite each other silently.
    const { rowCount } = await c.query('UPDATE app.support_tickets SET status = $2, reply = $3, handled_by = $4, updated_at = $5 WHERE id = $1 AND status = $6', [id, change.status, reply, actorUserId, at, before.status]);
    if (!rowCount) throw appError('APP_SUPPORT_STATE', `ticket ${id} changed meanwhile`);
    await writeAudit(c, { actorUserId, action: 'support.update', target: id, details: { from: before.status, to: change.status, replied: reply !== null } });
  });
  const changed = before.status !== change.status || before.reply !== reply;
  if (changed && before.user_id) await notify(db, notices.supportReply({ userId: before.user_id, ticketId: id, status: change.status, changedAt: at }));
  if (change.status === 'resolved' && before.status !== 'resolved') logEvent('info', 'support_ticket_resolved', { ticketId: id });
  return ticketDetail(deps, id);
}

export async function ticketFile(db: Db, id: string, ord: number): Promise<{ name: string; content: Buffer }> {
  await ticketRow(db, id);
  const { rows } = await db.query<{ name: string; content: Buffer | null }>('SELECT name, content FROM app.support_files WHERE ticket_id = $1 AND ord = $2', [id, ord]);
  if (!rows[0]?.content) throw appError('APP_NOT_FOUND', `file ${ord} of ticket ${id} not copied`, { userMessage: 'Этот файл не приложен к обращению.' });
  return { name: rows[0].name, content: rows[0].content };
}
