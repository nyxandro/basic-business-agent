// The conversation of a ticket (docs/specs/[20.11.2026]-feedback-and-value.md, F9; owner 24.11, by the classic help desks):
// both sides write as many messages as they need, with files; who wrote last sets the state — the employee's message
// waits for the support (open), the support's waits for the employee (answered). «Проблема решена» of the employee, or
// the support's «Решено» / «Отклонено», closes the ticket for both sides; the support may open it again. Each change is
// made on the ticket held by its transaction, so two presses at once never pass a closed ticket. The other side is told
// by a notification, and the open pages of those who handle the support hear every change at once (the red counter).
import { SUPPORT_FILES_MAX_BYTES, SUPPORT_REQUEST_FILES_MAX, isClosedStatus, type SupportKind, type SupportSide, type SupportStatus } from '@bba/contracts';
import type pg from 'pg';
import { writeAudit } from '../audit/audit.ts';
import { holdersOf } from '../auth/holders.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { logEvent } from '../log/log.ts';
import { notices } from '../notifications/kinds.ts';
import { signalLive } from '../notifications/live.ts';
import { notify } from '../notifications/notify.ts';

const FILE_NAME_MAX = 255;

// A file of a form. The form is in memory already (its size is held by the route's limit); its bytes are copied out of
// it only after the limits of a message are checked.
export interface AttachedFile {
  name: string;
  size: number;
  read: () => Promise<Uint8Array>;
}

export interface ReadFile {
  name: string;
  content: Uint8Array;
}

// The limits of one message: up to 10 files, 50 MB together, each with a name Postgres can keep.
export async function readAttached(files: readonly AttachedFile[]): Promise<ReadFile[]> {
  if (files.length > SUPPORT_REQUEST_FILES_MAX) throw appError('APP_SUPPORT_TOO_MANY_FILES', `${files.length} files attached to a message`);
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > SUPPORT_FILES_MAX_BYTES) throw appError('APP_SUPPORT_FILES_TOO_LARGE', `${total} bytes attached to a message`);
  // A zero character Postgres cannot keep; a browser never sends one in a name.
  const unnamed = files.find((f) => f.name.trim() === '' || f.name.length > FILE_NAME_MAX || f.name.includes('\0'));
  if (unnamed) throw appError('APP_VALIDATION_FAILED', `attached file name of ${unnamed.name.length} characters`, { userMessage: 'У файла нет имени или оно длиннее 255 знаков. Переименуйте файл и приложите снова.' });
  return Promise.all(files.map(async (f) => ({ name: f.name, content: await f.read() })));
}

// A message and its files, in the transaction that holds the ticket: its files take the next numbers of the ticket.
export async function insertMessage(c: pg.PoolClient, ticketId: string, side: SupportSide, authorId: string, text: string, files: readonly ReadFile[]): Promise<string> {
  const { rows } = await c.query<{ id: string }>('INSERT INTO app.support_messages (ticket_id, side, author_id, text) VALUES ($1, $2, $3, $4) RETURNING id::text', [ticketId, side, authorId, text]);
  const messageId = rows[0]?.id;
  if (!messageId) throw new Error('support message insert returned no id');
  const next = await c.query<{ ord: number }>('SELECT coalesce(max(ord) + 1, 0)::int AS ord FROM app.support_files WHERE ticket_id = $1', [ticketId]);
  const first = next.rows[0]?.ord;
  if (first === undefined) throw new Error('next file number of a ticket not read');
  for (const [i, f] of files.entries()) {
    // A view of the same bytes, not one more copy of up to 50 MB.
    const bytes = Buffer.from(f.content.buffer, f.content.byteOffset, f.content.byteLength);
    await c.query("INSERT INTO app.support_files (ticket_id, ord, name, path, size, state, content, message_id) VALUES ($1, $2, $3, NULL, $4, 'copied', $5, $6)", [ticketId, first + i, f.name, f.content.byteLength, bytes, messageId]);
  }
  return messageId;
}

interface HeldTicket {
  status: SupportStatus;
  user_id: string | null;
  kind: SupportKind;
}

const missing = (ticketId: string) => appError('APP_NOT_FOUND', `ticket ${ticketId} not found`, { userMessage: 'Обращение не найдено.' });

// The ticket locked for the change; `ownerId` — only a ticket of this person (another one's is as missing as none).
export async function heldTicket(c: pg.PoolClient, ticketId: string, ownerId: string | null): Promise<HeldTicket> {
  if (!/^\d{1,18}$/.test(ticketId)) throw missing(ticketId);
  const { rows } = await c.query<HeldTicket>('SELECT status, user_id, kind FROM app.support_tickets WHERE id = $1 AND ($2::text IS NULL OR user_id = $2) FOR UPDATE', [ticketId, ownerId]);
  if (!rows[0]) throw missing(ticketId);
  return rows[0];
}

const closedTicket = (ticketId: string) => appError('APP_SUPPORT_CLOSED', `ticket ${ticketId} is closed`);

// After the change is saved: telling never undoes it. A notification that fails is logged by `notify`; a failure to find
// whom to tell is logged here — the open pages catch up at their next check.
async function afterChange(db: Db, ticketId: string, tell: () => Promise<void>): Promise<void> {
  try {
    await tell();
    for (const holder of await holdersOf(db, 'agents')) await signalLive(db, holder);
  } catch (error) {
    logEvent('error', 'support_tell_failed', { code: 'APP_SUPPORT_FAILED', ticketId, error });
  }
}

// The people who handle the support, told of a message of the employee.
async function tellSupport(db: Db, ticketId: string, messageId: string): Promise<void> {
  for (const holder of await holdersOf(db, 'agents')) await notify(db, notices.supportMessage({ userId: holder, ticketId, messageId }));
}

// The employee writes into their own ticket: it waits for the support again. `reopen` — a second complaint about the same
// answer opens a closed complaint again; a message alone never does.
export async function employeeWrites(db: Db, userId: string, ticketId: string, text: string, files: readonly AttachedFile[], opts: { reopen: boolean } = { reopen: false }): Promise<{ messageId: string }> {
  const read = await readAttached(files);
  const messageId = await inTransaction(db, async (c) => {
    const ticket = await heldTicket(c, ticketId, userId);
    if (isClosedStatus(ticket.status) && !opts.reopen) throw closedTicket(ticketId);
    const id = await insertMessage(c, ticketId, 'employee', userId, text, read);
    await c.query("UPDATE app.support_tickets SET status = 'open', closed_side = NULL, closed_at = NULL, updated_at = now() WHERE id = $1", [ticketId]);
    return id;
  });
  logEvent('info', 'support_message', { ticketId, side: 'employee', files: files.length });
  await afterChange(db, ticketId, () => tellSupport(db, ticketId, messageId));
  return { messageId };
}

// The support answers: the ticket waits for the employee, who is told.
export async function supportWrites(db: Db, authorId: string, ticketId: string, text: string, files: readonly AttachedFile[]): Promise<{ messageId: string }> {
  const read = await readAttached(files);
  const { messageId, employee } = await inTransaction(db, async (c) => {
    const ticket = await heldTicket(c, ticketId, null);
    if (isClosedStatus(ticket.status)) throw closedTicket(ticketId);
    const id = await insertMessage(c, ticketId, 'support', authorId, text, read);
    await c.query("UPDATE app.support_tickets SET status = 'answered', updated_at = now() WHERE id = $1", [ticketId]);
    return { messageId: id, employee: ticket.user_id };
  });
  logEvent('info', 'support_message', { ticketId, side: 'support', files: files.length });
  await afterChange(db, ticketId, async () => {
    if (employee) await notify(db, notices.supportReply({ userId: employee, ticketId, event: 'reply', key: messageId }));
  });
  return { messageId };
}

// «Проблема решена»: the employee closes their ticket for both sides.
export async function employeeResolves(db: Db, userId: string, ticketId: string): Promise<void> {
  await inTransaction(db, async (c) => {
    const ticket = await heldTicket(c, ticketId, userId);
    if (isClosedStatus(ticket.status)) throw closedTicket(ticketId);
    await c.query("UPDATE app.support_tickets SET status = 'resolved', closed_side = 'employee', closed_at = now(), updated_at = now() WHERE id = $1", [ticketId]);
  });
  logEvent('info', 'support_ticket_closed', { ticketId, side: 'employee', status: 'resolved' });
  await afterChange(db, ticketId, () => Promise.resolve());
}

// The support closes a ticket as resolved or rejected, or opens a closed one again; the employee is told.
export async function supportSetsStatus(db: Db, actorId: string, ticketId: string, status: 'resolved' | 'rejected' | 'open'): Promise<void> {
  const { from, employee } = await inTransaction(db, async (c) => {
    const ticket = await heldTicket(c, ticketId, null);
    // Only an open ticket closes, only a closed one opens again.
    if (isClosedStatus(ticket.status) !== (status === 'open')) throw appError('APP_SUPPORT_STATE', `ticket ${ticketId}: ${ticket.status} → ${status}`);
    if (status === 'open') await c.query("UPDATE app.support_tickets SET status = 'open', closed_side = NULL, closed_at = NULL, updated_at = now() WHERE id = $1", [ticketId]);
    else await c.query("UPDATE app.support_tickets SET status = $2, closed_side = 'support', closed_at = now(), updated_at = now() WHERE id = $1", [ticketId, status]);
    await writeAudit(c, { actorUserId: actorId, action: 'support.update', target: ticketId, details: { from: ticket.status, to: status } });
    return { from: ticket.status, employee: ticket.user_id };
  });
  logEvent('info', 'support_ticket_closed', { ticketId, side: 'support', from, status });
  await afterChange(db, ticketId, async () => {
    if (employee) await notify(db, notices.supportReply({ userId: employee, ticketId, event: status === 'open' ? 'reopened' : status, key: String(Date.now()) }));
  });
}
