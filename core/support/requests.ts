// A request written straight to the support from «Мои обращения» (docs/specs/[20.11.2026]-feedback-and-value.md, F7; owner
// 24.11): the subject, the text and the files the employee attached become a ticket of «Поддержка» — nothing of a
// conversation goes with it. The people with «Агенты» are told, as of a complaint (F5).
import { SUPPORT_FILES_MAX_BYTES, SUPPORT_REQUEST_FILES_MAX, type SupportRequestResponse } from '@bba/contracts';
import { holdersOf } from '../auth/holders.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { logEvent } from '../log/log.ts';
import { notices } from '../notifications/kinds.ts';
import { notify } from '../notifications/notify.ts';

const FILE_NAME_MAX = 255;

// A file of the form. The form is in memory already (its size is held by the route's limit); its bytes are copied out of
// it only after the limits of a request are checked.
export interface AttachedFile {
  name: string;
  size: number;
  read: () => Promise<Uint8Array>;
}

function checkAttached(files: readonly AttachedFile[]): void {
  if (files.length > SUPPORT_REQUEST_FILES_MAX) throw appError('APP_SUPPORT_TOO_MANY_FILES', `${files.length} files attached to a request`);
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > SUPPORT_FILES_MAX_BYTES) throw appError('APP_SUPPORT_FILES_TOO_LARGE', `${total} bytes attached to a request`);
  // A zero character Postgres cannot keep; a browser never sends one in a name.
  const unnamed = files.find((f) => f.name.trim() === '' || f.name.length > FILE_NAME_MAX || f.name.includes('\0'));
  if (unnamed) throw appError('APP_VALIDATION_FAILED', `attached file name of ${unnamed.name.length} characters`, { userMessage: 'У файла нет имени или оно длиннее 255 знаков. Переименуйте файл и приложите снова.' });
}

export async function createRequest(db: Db, userId: string, input: { subject: string; text: string }, files: readonly AttachedFile[]): Promise<SupportRequestResponse> {
  checkAttached(files);
  const contents = await Promise.all(files.map((f) => f.read()));
  const id = await inTransaction(db, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.support_tickets (user_id, kind, subject, comment, snapshot, models, status) VALUES ($1, 'request', $2, $3, '[]', '{}', 'new') RETURNING id::text`,
      [userId, input.subject, input.text],
    );
    const ticketId = rows[0]?.id;
    if (!ticketId) throw new Error('support request insert returned no id');
    for (const [ord, f] of files.entries()) {
      const content = contents[ord]!;
      // A view of the same bytes, not one more copy of up to 50 MB.
      const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
      await c.query("INSERT INTO app.support_files (ticket_id, ord, name, path, size, state, content) VALUES ($1, $2, $3, NULL, $4, 'copied', $5)", [ticketId, ord, f.name, content.byteLength, bytes]);
    }
    return ticketId;
  });
  logEvent('info', 'support_request_created', { ticketId: id, files: files.length });
  for (const holder of await holdersOf(db, 'agents')) await notify(db, notices.supportRequest({ userId: holder, ticketId: id }));
  return { id };
}
