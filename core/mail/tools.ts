// What the agent does with the person's mail (spec, section 8.24): folders, the latest letters, a search,
// one letter read in full, an attachment put into the working folder — without asking; a letter sent or a
// reply — only after «Да» (core/approvals/policy.ts writes it into the journal). Every action works in one
// connection with the person's own access. Reading never marks a letter as read.
import { closeSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createTool } from '@mastra/core/tools';
import type { FetchMessageObject, ImapFlow, SearchObject } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { applyApprovalPolicy } from '../approvals/policy.ts';
import type { Db } from '../db/pool.ts';
import { isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import type { AnyTool } from '../plugins/public/index.ts';
import { requireContextValue, REQUEST_KEYS } from '../runtime/request-keys.ts';
import { logEvent } from '../server/log.ts';
import { runRoot } from '../sandbox/workspace.ts';
import { openFileInside, saveInFolder } from '../workspace/layout.ts';
import type { MailAccount } from './accounts.ts';
import { mailError, smtpTransport, withImap } from './client.ts';
import { pickAccount, type MailService } from './service.ts';
import { listNote } from '../widgets/prompt.ts';

export const MAIL_TOOL_NAMES = ['mailbox_folders', 'mailbox_list', 'mailbox_search', 'mailbox_read', 'mailbox_save_attachment', 'mailbox_send'] as const;
// How the chat names the system of these actions.
export const MAIL_SYSTEM = 'Почта';

const MAX_LIST = 50;
const DEFAULT_LIST = 20;
// Text of a letter given to the model; the rest is cut with a note.
const MAX_BODY_CHARS = 20_000;
// A letter larger than this is not read whole (attachments of dozens of megabytes).
const MAX_LETTER_BYTES = 30 * 1024 * 1024;
const MAX_SEND_BYTES = 25 * 1024 * 1024;
// Folder of the working folder where attachments are put.
const ATTACHMENTS_FOLDER = 'Почта';
// Services that keep a sent letter in «Отправленные» themselves: no copy is put there.
const KEEPS_SENT: ReadonlySet<string> = new Set(['google', 'microsoft']);

type Ctx = { requestContext?: { get(key: string): unknown } } | undefined;

interface Address {
  name?: string;
  address?: string;
}

const who = (list: Address[] | undefined) => (list ?? []).map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? ''))).filter(Boolean);

function hasAttachments(node: FetchMessageObject['bodyStructure']): boolean {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  return (node.childNodes ?? []).some(hasAttachments);
}

function summary(m: FetchMessageObject) {
  const date = m.envelope?.date ?? m.internalDate;
  return {
    uid: m.uid,
    date: date ? new Date(date).toISOString() : null,
    from: who(m.envelope?.from),
    to: who(m.envelope?.to),
    subject: m.envelope?.subject ?? '',
    unread: !m.flags?.has('\\Seen'),
    attachments: hasAttachments(m.bodyStructure),
  };
}

const letterNotFound = (uid: number, folder: string) =>
  appError('APP_NOT_FOUND', `no letter ${uid} in ${folder}`, { userMessage: `Письма ${uid} в папке «${folder}» нет — возможно, его удалили или переместили.` });

async function inFolder<T>(client: ImapFlow, folder: string, work: () => Promise<T>): Promise<T> {
  let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>>;
  try {
    lock = await client.getMailboxLock(folder, { readOnly: true });
  } catch (error) {
    // Only the server's «no such folder» is that; a broken connection is told as itself (mailError).
    const e = error as { serverResponseCode?: string; responseText?: string } | undefined;
    if (e?.serverResponseCode === 'NONEXISTENT' || /doesn.?t exist|does not exist|no such|unknown mailbox|not found/i.test(e?.responseText ?? '')) {
      throw appError('APP_NOT_FOUND', `no folder ${folder}`, { userMessage: `Папки «${folder}» в почте нет. Список папок — инструмент mailbox_folders.`, cause: error });
    }
    throw error;
  }
  try {
    return await work();
  } finally {
    lock.release();
  }
}

async function summaries(client: ImapFlow, uids: number[]) {
  if (uids.length === 0) return [];
  const out = [];
  for await (const m of client.fetch(uids.join(','), { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true }, { uid: true })) out.push(summary(m));
  return out.sort((a, b) => b.uid - a.uid);
}

async function parsedLetter(client: ImapFlow, folder: string, uid: number): Promise<ParsedMail> {
  const meta = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true });
  if (!meta) throw letterNotFound(uid, folder);
  if ((meta.size ?? 0) > MAX_LETTER_BYTES) throw appError('APP_VALIDATION_FAILED', `letter ${uid} is ${meta.size} bytes`, { userMessage: 'Письмо больше 30 МБ — целиком его не прочитать.' });
  const full = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
  if (!full || !full.source) throw letterNotFound(uid, folder);
  return simpleParser(full.source);
}

const addressesOf = (field: ParsedMail['from'] | ParsedMail['to']) => (Array.isArray(field) ? field : field ? [field] : []).flatMap((a) => who(a.value));

export interface MailToolsDeps {
  db: Db;
  mail: MailService;
  workspaceRoot: string;
  // The agent the person talks to (it alone has widgets): a list of three and more letters asks for a widget (#32).
  listNote: boolean;
}

// Runs an action with the person's mailbox; a refused way in marks the mailbox «Ошибка доступа».
async function withMailbox<T>(deps: MailToolsDeps, ctx: Ctx, email: string | undefined, work: (account: MailAccount, client: ImapFlow) => Promise<T>): Promise<T> {
  const account = await pickAccount(deps.mail, requireContextValue(ctx?.requestContext, REQUEST_KEYS.userId), email);
  try {
    return await withImap(account.servers, await deps.mail.loginOf(account), account.email, deps.mail.transport, (client) => work(account, client));
  } catch (error) {
    if (isAppError(error) && error.code === 'APP_MAIL_AUTH_FAILED') await deps.mail.refused(account);
    throw error;
  }
}

const accountField = z.string().optional().describe('Почтовый ящик, если подключено несколько (адрес); без него — первый');
const folderField = z.string().optional().describe('Папка почты; без неё — «Входящие» (INBOX)');

function readTools(deps: MailToolsDeps): Record<string, AnyTool> {
  const folders = createTool({
    id: 'mailbox_folders',
    description: 'Папки почты сотрудника. Возвращает путь папки и её роль (входящие, отправленные, черновики, спам, корзина).',
    inputSchema: z.object({ account: accountField }),
    execute: (input, ctx) =>
      withMailbox(deps, ctx as Ctx, input.account, async (_account, client) => ({ folders: (await client.list()).map((f) => ({ path: f.path, name: f.name, role: f.specialUse ?? null })) })),
  });
  const list = createTool({
    id: 'mailbox_list',
    description: 'Последние письма в папке почты сотрудника, новые первыми: номер письма (uid), дата, от кого, кому, тема, прочитано ли, есть ли вложения.',
    inputSchema: z.object({
      account: accountField,
      folder: folderField,
      unreadOnly: z.boolean().optional().describe('Только непрочитанные'),
      limit: z.number().int().min(1).max(MAX_LIST).optional().describe(`Сколько писем, до ${MAX_LIST}; без него — ${DEFAULT_LIST}`),
      beforeUid: z.number().int().optional().describe('Письма старше этого номера — следующая страница'),
    }),
    execute: (input, ctx) =>
      withMailbox(deps, ctx as Ctx, input.account, async (_account, client) => {
        const folder = input.folder ?? 'INBOX';
        return inFolder(client, folder, async () => {
          const query: SearchObject = input.unreadOnly ? { seen: false } : { all: true };
          const all = ((await client.search(query, { uid: true })) || []).filter((uid) => !input.beforeUid || uid < input.beforeUid).sort((a, b) => a - b);
          const limit = input.limit ?? DEFAULT_LIST;
          const letters = await summaries(client, all.slice(-limit));
          return { folder, letters, older: all.length > limit, ...(deps.listNote ? listNote(ctx, letters.length) : {}) };
        });
      }),
  });
  const search = createTool({
    id: 'mailbox_search',
    description: 'Поиск писем в почте сотрудника по словам, отправителю, получателю, теме и датам; новые первыми.',
    inputSchema: z.object({
      account: accountField,
      folder: folderField,
      text: z.string().optional().describe('Слова в теме или тексте письма'),
      from: z.string().optional().describe('От кого: адрес или имя'),
      to: z.string().optional().describe('Кому: адрес или имя'),
      subject: z.string().optional().describe('Слова в теме'),
      since: z.string().optional().describe('Не раньше этой даты, ГГГГ-ММ-ДД'),
      before: z.string().optional().describe('Раньше этой даты, ГГГГ-ММ-ДД'),
      unreadOnly: z.boolean().optional().describe('Только непрочитанные'),
      limit: z.number().int().min(1).max(MAX_LIST).optional().describe(`Сколько писем, до ${MAX_LIST}`),
    }),
    execute: (input, ctx) =>
      withMailbox(deps, ctx as Ctx, input.account, async (_account, client) => {
        const folder = input.folder ?? 'INBOX';
        const query: SearchObject = {
          ...(input.text ? { text: input.text } : {}),
          ...(input.from ? { from: input.from } : {}),
          ...(input.to ? { to: input.to } : {}),
          ...(input.subject ? { subject: input.subject } : {}),
          ...(input.since ? { since: new Date(input.since) } : {}),
          ...(input.before ? { before: new Date(input.before) } : {}),
          ...(input.unreadOnly ? { seen: false } : {}),
        };
        if (Object.keys(query).length === 0) throw appError('APP_VALIDATION_FAILED', 'empty mail search', { userMessage: 'Укажи, что искать: слова, отправителя, тему или даты.' });
        return inFolder(client, folder, async () => {
          const found = ((await client.search(query, { uid: true })) || []).sort((a, b) => a - b);
          const limit = input.limit ?? DEFAULT_LIST;
          const letters = await summaries(client, found.slice(-limit));
          return { folder, letters, more: found.length > limit, ...(deps.listNote ? listNote(ctx, letters.length) : {}) };
        });
      }),
  });
  const read = createTool({
    id: 'mailbox_read',
    description: 'Письмо целиком: от кого, кому, копия, дата, тема, текст и список вложений (номер, имя, размер). Письмо остаётся непрочитанным, если было таким.',
    inputSchema: z.object({ account: accountField, folder: folderField, uid: z.number().int().describe('Номер письма (uid)') }),
    execute: (input, ctx) =>
      withMailbox(deps, ctx as Ctx, input.account, async (_account, client) => {
        const folder = input.folder ?? 'INBOX';
        return inFolder(client, folder, async () => {
          const letter = await parsedLetter(client, folder, input.uid);
          const text = letter.text ?? '';
          return {
            folder,
            uid: input.uid,
            from: addressesOf(letter.from),
            to: addressesOf(letter.to),
            cc: addressesOf(letter.cc),
            date: letter.date?.toISOString() ?? null,
            subject: letter.subject ?? '',
            text: text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n…[текст письма обрезан: ещё ${text.length - MAX_BODY_CHARS} символов]` : text,
            attachments: letter.attachments.map((a, i) => ({ number: i + 1, name: a.filename ?? `вложение-${i + 1}`, bytes: a.size, type: a.contentType })),
          };
        });
      }),
  });
  const save = createTool({
    id: 'mailbox_save_attachment',
    description: `Сохраняет вложение письма в рабочую папку (папка «${ATTACHMENTS_FOLDER}»), чтобы прочитать его скиллами или приложить к другому письму. Возвращает путь файла.`,
    inputSchema: z.object({ account: accountField, folder: folderField, uid: z.number().int().describe('Номер письма (uid)'), number: z.number().int().min(1).describe('Номер вложения из mailbox_read') }),
    execute: (input, ctx) =>
      withMailbox(deps, ctx as Ctx, input.account, async (_account, client) => {
        const folder = input.folder ?? 'INBOX';
        const letter = await inFolder(client, folder, () => parsedLetter(client, folder, input.uid));
        const attachment = letter.attachments[input.number - 1];
        if (!attachment) throw appError('APP_NOT_FOUND', `no attachment ${input.number}`, { userMessage: `У письма нет вложения с номером ${input.number}.` });
        const root = runRoot(deps.workspaceRoot, (ctx as Ctx)?.requestContext);
        // Any type: a signature (.p7s), an archive, a letter — it lands only in the working folder.
        const saved = saveInFolder(root, ATTACHMENTS_FOLDER, attachment.filename ?? `вложение-${input.number}`, new Uint8Array(attachment.content), { anyType: true });
        return { path: saved.path, bytes: saved.bytes };
      }),
  });
  return Object.fromEntries([folders, list, search, read, save].map((t) => [t.id, applyApprovalPolicy(t as AnyTool, { readOnly: true, db: deps.db })]));
}

function readAttachment(root: string, path: string): { filename: string; content: Buffer } {
  const file = openFileInside(root, path);
  if (!file) throw appError('APP_NOT_FOUND', `no file ${path} to attach`, { userMessage: `Файла ${path} в рабочей папке нет.` });
  try {
    return { filename: basename(path), content: readFileSync(file.fd) };
  } finally {
    closeSync(file.fd);
  }
}

async function sentFolder(client: ImapFlow): Promise<string | null> {
  return (await client.list()).find((f) => f.specialUse === '\\Sent')?.path ?? null;
}

function sendTool(deps: MailToolsDeps): AnyTool {
  const tool = createTool({
    id: 'mailbox_send',
    description: 'Отправить письмо из почты сотрудника. Ответ на письмо — с номером исходного письма (replyToUid): тема и цепочка письма сохранятся.',
    inputSchema: z.object({
      account: accountField,
      to: z.array(z.string()).min(1).describe('Кому'),
      cc: z.array(z.string()).optional().describe('Копия'),
      subject: z.string().optional().describe('Тема'),
      text: z.string().describe('Текст письма'),
      attachments: z.array(z.string()).optional().describe('Вложения — файлы рабочей папки'),
      replyToUid: z.number().int().optional().describe('Ответ на письмо с этим номером'),
      replyFolder: z.string().optional().describe('Папка письма, на которое ответ'),
    }),
    execute: async (input, ctx) => {
      const c = ctx as Ctx;
      const userId = requireContextValue(c?.requestContext, REQUEST_KEYS.userId);
      const account = await pickAccount(deps.mail, userId, input.account);
      const root = runRoot(deps.workspaceRoot, c?.requestContext);
      const files = (input.attachments ?? []).map((p) => readAttachment(root, p));
      if (files.reduce((n, f) => n + f.content.length, 0) > MAX_SEND_BYTES) throw appError('APP_VALIDATION_FAILED', 'attachments over 25 MB', { userMessage: 'Вложения больше 25 МБ — почтовые серверы такое письмо не примут.' });
      const { rows } = await deps.db.query<{ name: string }>('SELECT "name" FROM app."user" WHERE "id" = $1', [userId]);
      const refused = async (error: unknown) => {
        if (isAppError(error) && error.code === 'APP_MAIL_AUTH_FAILED') await deps.mail.refused(account);
        return error;
      };
      // Before the letter goes: the thread of a reply (its own connection — nothing is sent yet).
      let thread: { inReplyTo?: string; references?: string[]; subject?: string } = {};
      if (input.replyToUid) {
        const folder = input.replyFolder ?? 'INBOX';
        const original = await withImap(account.servers, await deps.mail.loginOf(account), account.email, deps.mail.transport, (client) => inFolder(client, folder, () => parsedLetter(client, folder, input.replyToUid!))).catch(async (error: unknown) => {
          throw await refused(error);
        });
        const refs = [...(Array.isArray(original.references) ? original.references : original.references ? [original.references] : []), ...(original.messageId ? [original.messageId] : [])];
        thread = { ...(original.messageId ? { inReplyTo: original.messageId } : {}), references: refs, subject: /^re:/i.test(original.subject ?? '') ? original.subject : `Re: ${original.subject ?? ''}` };
      }
      const subject = input.subject ?? thread.subject ?? '';
      // The letter is built once: the same bytes go to the server and into «Отправленные».
      const built = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({
        from: rows[0]?.name ? { name: rows[0].name, address: account.email } : account.email,
        to: input.to,
        ...(input.cc?.length ? { cc: input.cc } : {}),
        subject,
        text: input.text,
        ...(thread.inReplyTo ? { inReplyTo: thread.inReplyTo } : {}),
        ...(thread.references?.length ? { references: thread.references } : {}),
        attachments: files,
      });
      const raw = built.message as Buffer;
      const login = await deps.mail.loginOf(account);
      const smtp = smtpTransport(account.servers, login, deps.mail.transport);
      try {
        await smtp.sendMail({ envelope: { from: account.email, to: [...input.to, ...(input.cc ?? [])] }, raw });
      } catch (error) {
        throw await refused(mailError(error, account.email, account.servers.smtp.host));
      } finally {
        smtp.close();
      }
      // The letter is gone: whatever happens with its copy, the answer says it was sent — saying otherwise
      // would make the agent send it again.
      let savedTo: string | null = null;
      let copyFailed = false;
      if (!KEEPS_SENT.has(account.provider)) {
        try {
          savedTo = await withImap(account.servers, login, account.email, deps.mail.transport, async (client) => {
            const sent = await sentFolder(client);
            if (sent) await client.append(sent, raw, ['\\Seen']);
            return sent;
          });
        } catch (error) {
          copyFailed = true;
          logEvent('warn', 'mail_sent_copy_failed', { code: isAppError(error) ? error.code : 'APP_MAIL_FAILED', userId, error: isAppError(error) ? error.code : (error as Error).name });
        }
      }
      return {
        sent: true,
        from: account.email,
        to: input.to,
        subject,
        messageId: built.messageId,
        savedTo,
        ...(copyFailed ? { note: 'Письмо отправлено, но его копию не удалось положить в «Отправленные». Не отправляй его повторно.' } : {}),
      };
    },
  });
  return applyApprovalPolicy(tool as AnyTool, { readOnly: false, db: deps.db });
}

export function createMailTools(deps: MailToolsDeps): Record<string, AnyTool> {
  return { ...readTools(deps), mailbox_send: sendTool(deps) };
}
