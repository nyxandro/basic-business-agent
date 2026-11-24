// Routes of «Поддержка» (docs/specs/[20.11.2026]-feedback-and-value.md, section 17; F7–F9): the employee — a complaint about
// an answer, a request straight to the support, «Мои обращения», a ticket's conversation, its messages, «Проблема решена»
// and its files; the admin panel — the list, a ticket, its messages, closing and opening again, its files — for the
// people with «Агенты» (owner 21.11, F5).
import { COMPLAINT_MAX, complaintSchema, SUPPORT_FILES_MAX_BYTES, SUPPORT_STATUSES, SUPPORT_SUBJECT_MAX, supportMessageSchema, supportRequestSchema, supportStatusSchema, type AdminTicketsResponse, type ComplaintStateResponse, type MyTicketsResponse, type SupportStatus } from '@bba/contracts';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import { appError } from '../errors/catalog.ts';
import { requirePermission } from '../auth/guards.ts';
import { access, parseJson, type AppEnv } from '../http/http.ts';
import { MULTIPART_OVERHEAD_BYTES } from '../projects/routes.ts';
import { employeeResolves, employeeWrites, supportSetsStatus, supportWrites, type AttachedFile } from './messages.ts';
import { createRequest } from './requests.ts';
import { complain, existingComplaint, listTickets, myTicket, myTicketFile, myTickets, ticketDetail, ticketFile, type SupportDeps } from './tickets.ts';

const S = '/app/api/admin/support';
const ME = '/app/api/me/support';

// A form with files counts its bytes even without Content-Length, before it is read into memory.
const formLimit = () =>
  bodyLimit({
    maxSize: SUPPORT_FILES_MAX_BYTES + MULTIPART_OVERHEAD_BYTES,
    onError: () => {
      throw appError('APP_SUPPORT_FILES_TOO_LARGE', 'support form over the limit');
    },
  });

// What a person is told of a form filled wrong.
const REQUEST_FORM = { schema: supportRequestSchema, userMessage: `Заполните поля формы: тема — до ${SUPPORT_SUBJECT_MAX} знаков, текст — до ${COMPLAINT_MAX}.` };
const MESSAGE_FORM = { schema: supportMessageSchema, userMessage: `Напишите сообщение — до ${COMPLAINT_MAX} знаков.` };

// The text fields of a form, and its files (`files`): one comes as a value, several as a list (Hono, `all`).
async function readForm<T extends z.ZodType>(c: Context<AppEnv>, form: { schema: T; userMessage: string }): Promise<{ fields: z.infer<T>; files: AttachedFile[] }> {
  const body = await c.req.parseBody({ all: true });
  const { files: raw, ...rest } = body;
  const fields = form.schema.safeParse(rest);
  if (!fields.success) throw appError('APP_VALIDATION_FAILED', `bad support form: ${fields.error.message}`, { userMessage: form.userMessage });
  const list = raw === undefined ? [] : [raw].flat();
  if (list.some((f) => !(f instanceof File))) throw appError('APP_VALIDATION_FAILED', 'files field is not a file', { userMessage: 'Файл не получен. Приложите его ещё раз.' });
  return { fields: fields.data, files: (list as File[]).map((f) => ({ name: f.name, size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) })) };
}

function fileNumber(c: Context<AppEnv>): number {
  const ord = Number(c.req.param('ord'));
  if (!Number.isInteger(ord) || ord < 0 || ord > 100_000) throw appError('APP_VALIDATION_FAILED', `bad file number "${c.req.param('ord')}"`);
  return ord;
}

const download = (file: { name: string; content: Buffer }) =>
  new Response(new Uint8Array(file.content), {
    headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'x-content-type-options': 'nosniff' },
  });

export function registerSupportRoutes(app: Hono<AppEnv>, deps: SupportDeps): void {
  const agents = requirePermission('agents');

  // The employee.
  app.post(ME, async (c) => c.json(await complain(deps, access(c).userId, await parseJson(c, complaintSchema)), 201));

  app.post(`${ME}/requests`, formLimit(), async (c) => {
    const { fields, files } = await readForm(c, REQUEST_FORM);
    return c.json(await createRequest(deps.db, access(c).userId, fields, files), 201);
  });

  app.get(ME, async (c) => c.json({ tickets: await myTickets(deps, access(c).userId) } satisfies MyTicketsResponse));

  // Before `:id`: «turn» is not a ticket.
  app.get(`${ME}/turn`, async (c) => {
    const threadId = c.req.query('threadId');
    const turn = Number(c.req.query('turn'));
    if (!threadId || !Number.isInteger(turn) || turn < 1 || turn > 1_000_000) throw appError('APP_VALIDATION_FAILED', 'threadId and turn are required');
    return c.json({ ticket: await existingComplaint(deps.db, access(c).userId, threadId, turn) } satisfies ComplaintStateResponse);
  });

  app.get(`${ME}/:id`, async (c) => c.json(await myTicket(deps, access(c).userId, c.req.param('id'))));

  app.post(`${ME}/:id/messages`, formLimit(), async (c) => {
    const { fields, files } = await readForm(c, MESSAGE_FORM);
    return c.json(await employeeWrites(deps.db, access(c).userId, c.req.param('id'), fields.text, files), 201);
  });

  app.post(`${ME}/:id/resolve`, async (c) => {
    await employeeResolves(deps.db, access(c).userId, c.req.param('id'));
    return c.json(await myTicket(deps, access(c).userId, c.req.param('id')));
  });

  app.get(`${ME}/:id/files/:ord`, async (c) => download(await myTicketFile(deps.db, access(c).userId, c.req.param('id'), fileNumber(c))));

  // The support.
  app.get(S, agents, async (c) => {
    const raw = c.req.query('status');
    const status = raw && (SUPPORT_STATUSES as readonly string[]).includes(raw) ? (raw as SupportStatus) : null;
    if (raw && !status) throw appError('APP_VALIDATION_FAILED', `unknown ticket status "${raw}"`);
    return c.json({ tickets: await listTickets(deps, status) } satisfies AdminTicketsResponse);
  });

  app.get(`${S}/:id`, agents, async (c) => c.json(await ticketDetail(deps, c.req.param('id'))));

  app.post(`${S}/:id/messages`, agents, formLimit(), async (c) => {
    const { fields, files } = await readForm(c, MESSAGE_FORM);
    return c.json(await supportWrites(deps.db, access(c).userId, c.req.param('id'), fields.text, files), 201);
  });

  app.post(`${S}/:id/status`, agents, async (c) => {
    const { status } = await parseJson(c, supportStatusSchema);
    await supportSetsStatus(deps.db, access(c).userId, c.req.param('id'), status);
    return c.json(await ticketDetail(deps, c.req.param('id')));
  });

  app.get(`${S}/:id/files/:ord`, agents, async (c) => download(await ticketFile(deps.db, c.req.param('id'), fileNumber(c))));
}
