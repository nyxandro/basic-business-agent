// A request written straight to the support from «Мои обращения» (docs/specs/[20.11.2026]-feedback-and-value.md, F7, F9;
// owner 24.11): the subject, and the text with the files the employee attached as the first message of its conversation —
// nothing of a chat with an agent goes with it. The people with «Агенты» are told, as of a complaint (F5).
import type { SupportRequestResponse } from '@bba/contracts';
import { holdersOf } from '../auth/holders.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { logEvent } from '../log/log.ts';
import { notices } from '../notifications/kinds.ts';
import { notify } from '../notifications/notify.ts';
import { insertMessage, readAttached, type AttachedFile } from './messages.ts';

export async function createRequest(db: Db, userId: string, input: { subject: string; text: string }, files: readonly AttachedFile[]): Promise<SupportRequestResponse> {
  const read = await readAttached(files);
  const id = await inTransaction(db, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.support_tickets (user_id, kind, subject, snapshot, models, status) VALUES ($1, 'request', $2, '[]', '{}', 'open') RETURNING id::text`,
      [userId, input.subject],
    );
    const ticketId = rows[0]?.id;
    if (!ticketId) throw new Error('support request insert returned no id');
    await insertMessage(c, ticketId, 'employee', userId, input.text, read);
    return ticketId;
  });
  logEvent('info', 'support_request_created', { ticketId: id, files: files.length });
  for (const holder of await holdersOf(db, 'agents')) await notify(db, notices.supportNew({ userId: holder, ticketId: id, complaintOf: null }));
  return { id };
}
