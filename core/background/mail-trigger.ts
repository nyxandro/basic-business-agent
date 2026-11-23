// The check of mailboxes for mail tasks (docs/specs/[20.11.2026]-event-tasks.md, scenario 3, section 8). Once a
// minute the server looks for new letters in the «Входящие» of the people of active mail tasks, with each one's own
// access, read-only (the letter stays unread). Where it stopped is kept per mailbox: the number of the last letter
// seen with its UIDVALIDITY. A letter is an event of a task when it came after the task was switched on and less than a
// day ago, is not from the mailbox's own address, is no automatic reply, and fits the filter; its Message-ID is the
// key, so a letter to a shared address of a department is handled once — by the first mailbox seen.
import type { FetchMessageObject, ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Db } from '../db/pool.ts';
import { isAppError } from '../errors/app-error.ts';
import type { MailAccount } from '../mail/accounts.ts';
import { withImap } from '../mail/client.ts';
import type { MailService } from '../mail/service.ts';
import { logEvent } from '../log/log.ts';
import { LETTER_TEXT_MAX, recordEvent } from './events.ts';
import { membersOf } from './scope.ts';
import type { TaskRow } from './service.ts';
import { letterFits } from './triggers.ts';

export const POLL_INTERVAL_MS = 60 * 1000;
export const POLL_CONNECTIONS = 5;
export const MAILBOX_TIME_MS = 60 * 1000;
const FOLDER = 'INBOX';
const DAY_MS = 24 * 60 * 60 * 1000;
// A letter bigger than this is not read for its text: the agent opens it with mailbox_read.
const TEXT_READ_MAX_BYTES = 2 * 1024 * 1024;

export interface MailTrigger {
  // One check of every mailbox of active mail tasks; resolves when it is done.
  poll(now?: Date): Promise<void>;
  start(): void;
  stop(): void;
}

interface Cursor {
  uidvalidity: string;
  last_uid: string;
  checked_at: Date;
}

type Mail = Pick<MailService, 'connected' | 'loginOf' | 'refused' | 'transport'>;

const AUTO_REPLY = /^(auto-replied|auto-generated|auto-notified)/i;

// An automatic reply: «Auto-Submitted» other than «no» (RFC 3834), or the marks some servers put instead.
function isAutomatic(headers: Map<string, string>): boolean {
  const submitted = String(headers.get('auto-submitted') ?? '').trim();
  if (submitted !== '' && AUTO_REPLY.test(submitted)) return true;
  if (headers.has('x-autoreply') || headers.has('x-autorespond')) return true;
  return /auto_reply/i.test(String(headers.get('precedence') ?? ''));
}

// The first characters of a letter for its run, and how long it is (the run is told it reads a part).
async function textOf(client: ImapFlow, uid: number, size: number): Promise<{ text: string; length: number }> {
  if (size > TEXT_READ_MAX_BYTES) return { text: '[Письмо большое — прочитай его целиком инструментом mailbox_read.]', length: 0 };
  const full = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
  if (!full || !full.source) return { text: '', length: 0 };
  const parsed = await simpleParser(full.source);
  const chars = [...(parsed.text ?? '').trim()];
  return { text: chars.slice(0, LETTER_TEXT_MAX).join(''), length: chars.length };
}

// Answers of a mail server that are about the server now, not about the password: too many connections, unavailable.
const NOT_THE_PASSWORD = new Set(['UNAVAILABLE', 'INUSE', 'LIMIT', 'SERVERBUG', 'CONTACTADMIN', 'OVERQUOTA']);
function passwordRefused(error: unknown): boolean {
  if (!isAppError(error) || error.code !== 'APP_MAIL_AUTH_FAILED') return false;
  const response = (error.cause as { serverResponseCode?: unknown } | undefined)?.serverResponseCode;
  return !(typeof response === 'string' && NOT_THE_PASSWORD.has(response.toUpperCase()));
}

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mailbox check took over ${ms} ms`)), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });

// `intervalMs` — how often the check runs: POLL_INTERVAL_MS in an installation; the browser stand checks more often.
export function createMailTrigger(deps: { db: Db; mail: Mail; wake: () => void; intervalMs: number }): MailTrigger {
  const { db } = deps;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  // A mailbox whose check outlived its minute keeps its connection until done: no second one is opened meanwhile.
  const checking = new Set<string>();

  // The letters of one mailbox for the tasks it serves; the place it stopped moves once all of them are written.
  async function checkMailbox(account: MailAccount, tasks: TaskRow[], now: Date): Promise<void> {
    const login = await deps.mail.loginOf(account);
    await withImap(account.servers, login, account.email, deps.mail.transport, async (client) => {
      const lock = await client.getMailboxLock(FOLDER, { readOnly: true });
      try {
        const box = client.mailbox;
        if (!box) throw new Error('mailbox not open');
        const validity = String(box.uidValidity);
        const { rows } = await db.query<Cursor>('SELECT uidvalidity::text, last_uid::text, checked_at FROM app.mail_trigger_cursors WHERE mail_account_id = $1 AND folder = $2', [account.id, FOLDER]);
        const cursor = rows[0];
        if (cursor && cursor.uidvalidity !== validity) logEvent('warn', 'mail_trigger_reset', { accountId: account.id });
        // A place last seen more than a day ago is no use: letters older than a day are not handled anyway, and the
        // letters since then would be one huge fetch.
        const fresh = cursor && cursor.uidvalidity === validity && now.getTime() - cursor.checked_at.getTime() < DAY_MS;
        const from = fresh ? Number(cursor.last_uid) : null;
        // Without a place to go on from (a new mailbox, a changed UIDVALIDITY) — the letters of the last day.
        const found = from !== null ? ((await client.search({ uid: `${from + 1}:*` }, { uid: true })) || []) : ((await client.search({ since: new Date(now.getTime() - DAY_MS) }, { uid: true })) || []);
        // `UID n:*` gives the last letter even when there is none newer.
        const uids = found.filter((uid) => from === null || uid > from).sort((a, b) => a - b);
        let last = from ?? 0;
        if (uids.length > 0) {
          // The list first: no other command may go on the connection while a FETCH is being read (imapflow waits).
          const letters: FetchMessageObject[] = [];
          for await (const m of client.fetch(uids.join(','), { uid: true, envelope: true, internalDate: true, size: true, headers: ['auto-submitted', 'x-autoreply', 'x-autorespond', 'precedence'] }, { uid: true })) letters.push(m);
          for (const m of letters) {
            last = Math.max(last, m.uid);
            const received = m.internalDate ? new Date(m.internalDate) : null;
            const sender = m.envelope?.from?.[0];
            const address = (sender?.address ?? '').toLowerCase();
            if (!received || received.getTime() < now.getTime() - DAY_MS || address === account.email.toLowerCase()) continue;
            const headers = m.headers ? parseHeaderBlock(m.headers.toString('utf8')) : new Map<string, string>();
            if (isAutomatic(headers)) continue;
            const subject = m.envelope?.subject ?? '';
            // INTERNALDATE has whole seconds: a letter of the very second the task was switched on counts as after it.
            const fitting = tasks.filter((task) => received.getTime() >= Math.floor(task.activated_at.getTime() / 1000) * 1000 && task.mail_filter && letterFits(task.mail_filter, { from: address, subject }));
            if (fitting.length === 0) continue;
            const messageId = m.envelope?.messageId?.trim().toLowerCase();
            const key = messageId ? `mail:${messageId}` : `mail:${account.id}:${validity}:${m.uid}`;
            const { text, length } = await textOf(client, m.uid, m.size ?? 0);
            const fromText = sender?.name ? `${sender.name} <${address}>` : address;
            for (const task of fitting) {
              const recorded = await recordEvent(db, { task, userId: account.userId, key, keyUntil: null, summary: null, payload: { kind: 'mail', accountId: account.id, email: account.email, folder: FOLDER, uid: m.uid, from: fromText, subject, date: received.toISOString(), text, length } });
              if (recorded.outcome === 'queued') deps.wake();
            }
          }
        } else if (from === null) {
          last = Math.max(0, Number(box.uidNext) - 1);
        }
        await db.query(
          `INSERT INTO app.mail_trigger_cursors (mail_account_id, folder, uidvalidity, last_uid, checked_at) VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (mail_account_id, folder) DO UPDATE SET uidvalidity = $3, last_uid = $4, checked_at = now()`,
          [account.id, FOLDER, validity, last],
        );
      } finally {
        lock.release();
      }
    });
  }

  async function pollOnce(now: Date): Promise<void> {
    const { rows: tasks } = await db.query<TaskRow>("SELECT * FROM app.background_tasks WHERE trigger = 'mail' AND status = 'active'");
    if (tasks.length === 0) return;
    // The mailboxes of the people of every task, each with the tasks it serves.
    const byAccount = new Map<string, { account: MailAccount; tasks: TaskRow[] }>();
    for (const task of tasks) {
      for (const member of await membersOf(db, task.id, task.scope, task.agent_id)) {
        if (member.skip) continue;
        for (const account of await deps.mail.connected(member.userId)) {
          const entry = byAccount.get(account.id) ?? { account, tasks: [] };
          entry.tasks.push(task);
          byAccount.set(account.id, entry);
        }
      }
    }
    const queue = [...byAccount.values()].filter(({ account }) => !checking.has(account.id));
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { account, tasks: served } = next;
        checking.add(account.id);
        const check = checkMailbox(account, served, now).finally(() => checking.delete(account.id));
        try {
          await withTimeout(check, MAILBOX_TIME_MS);
        } catch (error) {
          // A refused password is «Ошибка доступа», as for the agent's tools; a busy or unavailable server and
          // anything else wait for the next minute.
          if (passwordRefused(error)) await deps.mail.refused(account);
          logEvent('warn', 'mail_trigger_failed', { accountId: account.id, code: isAppError(error) ? error.code : 'APP_INTERNAL', error });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(POLL_CONNECTIONS, queue.length) }, worker));
    logEvent('info', 'mail_trigger_poll', { tasks: tasks.length, mailboxes: byAccount.size, ms: Date.now() - now.getTime() });
  }

  const trigger: MailTrigger = {
    poll(now = new Date()) {
      // One check at a time: a slow minute does not stack a second one on it.
      running ??= pollOnce(now).finally(() => (running = null));
      return running;
    },
    start() {
      timer = setInterval(() => void trigger.poll().catch((error: unknown) => logEvent('error', 'mail_trigger_poll_failed', { error })), deps.intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return trigger;
}

// The raw header lines imapflow gives for `headers`: name → value, names in lower case, folded lines joined.
function parseHeaderBlock(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) out.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return out;
}
