// Routes of complaints (docs/specs/[20.11.2026]-feedback-and-value.md, section 17): the employee's complaint about an
// answer, the complaint already made about a turn, «Мои обращения»; «Поддержка» of the admin panel — the list, a ticket,
// its state and answer, its files — for the people with «Агенты» (owner 21.11, F5).
import { complaintSchema, SUPPORT_STATUSES, ticketUpdateSchema, type AdminTicketsResponse, type ComplaintStateResponse, type MyTicketsResponse, type SupportStatus } from '@bba/contracts';
import type { Hono } from 'hono';
import { appError } from '../errors/catalog.ts';
import { requirePermission } from '../server/guards.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { complain, existingComplaint, listTickets, myTickets, ticketDetail, ticketFile, updateTicket, type SupportDeps } from './tickets.ts';

const S = '/app/api/admin/support';

export function registerSupportRoutes(app: Hono<AppEnv>, deps: SupportDeps): void {
  const agents = requirePermission('agents');

  app.post('/app/api/me/support', async (c) => c.json(await complain(deps, access(c).userId, await parseJson(c, complaintSchema)), 201));

  app.get('/app/api/me/support', async (c) => c.json({ tickets: await myTickets(deps, access(c).userId) } satisfies MyTicketsResponse));

  app.get('/app/api/me/support/turn', async (c) => {
    const threadId = c.req.query('threadId');
    const turn = Number(c.req.query('turn'));
    if (!threadId || !Number.isInteger(turn) || turn < 1) throw appError('APP_VALIDATION_FAILED', 'threadId and turn are required');
    return c.json({ ticket: await existingComplaint(deps.db, access(c).userId, threadId, turn) } satisfies ComplaintStateResponse);
  });

  app.get(S, agents, async (c) => {
    const raw = c.req.query('status');
    const status = raw && (SUPPORT_STATUSES as readonly string[]).includes(raw) ? (raw as SupportStatus) : null;
    if (raw && !status) throw appError('APP_VALIDATION_FAILED', `unknown ticket status "${raw}"`);
    return c.json({ tickets: await listTickets(deps, status) } satisfies AdminTicketsResponse);
  });

  app.get(`${S}/:id`, agents, async (c) => c.json(await ticketDetail(deps, c.req.param('id'))));

  app.patch(`${S}/:id`, agents, async (c) => c.json(await updateTicket(deps, access(c).userId, c.req.param('id'), await parseJson(c, ticketUpdateSchema))));

  app.get(`${S}/:id/files/:ord`, agents, async (c) => {
    const ord = Number(c.req.param('ord'));
    if (!Number.isInteger(ord) || ord < 0) throw appError('APP_VALIDATION_FAILED', `bad file number "${c.req.param('ord')}"`);
    const file = await ticketFile(deps.db, c.req.param('id'), ord);
    return new Response(new Uint8Array(file.content), {
      headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'x-content-type-options': 'nosniff' },
    });
  });
}
