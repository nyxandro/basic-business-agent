// Routes of multi-step approvals (docs/specs/[20.11.2026]-multi-step-approvals.md, section 17):
// - «Согласования» of the admin panel (right «Агенты»): the rules and the actions they may be set on; the heads of a
//   department;
// - the card of «Да»: whether the call needs approvals and by whom, and «Зачем» before the answer;
// - «Ждёт подтверждения»: the requests waiting for me and my own; a decision, «Отозвать», «Повторить выполнение».
// A request is shown only to its employee and to its approvers.
import { approvalRuleInputSchema, chainDecisionSchema, chainReasonSchema, departmentHeadsSchema, type ActionDescription, type ApprovalRulesResponse, type ChainPreviewResponse, type ChainsResponse } from '@bba/contracts';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import type { Registry } from '../loader/registry.ts';
import { requirePermission } from '../server/guards.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import { resolveStages } from './approvers.ts';
import { canSee, chainDto, chainRow, decideChain, withdrawChain, type ChainRow } from './chains.ts';
import type { ChainContinuation } from './continue.ts';
import { agentActions } from './describe.ts';
import type { ChainExecutor } from './execute.ts';
import { deleteRule, listRules, rulesFor, saveRule, setDepartmentHeads } from './rules.ts';

export interface ChainRouteDeps {
  db: Db;
  box: SecretBox;
  registry: Registry;
  executor: ChainExecutor;
  continuation: ChainContinuation;
  // The actions of the mailbox and of the connected systems, by their names (the chat's list).
  extraActions: () => Record<string, ActionDescription & { system?: string }>;
}

const previewSchema = z.strictObject({ tool: z.string().min(1).max(200) });
const CHAINS_SHOWN = 50;

export function registerChainRoutes(app: Hono<AppEnv>, deps: ChainRouteDeps): void {
  const { db, box } = deps;
  const agents = requirePermission('agents');
  const agentName = (id: string) => deps.registry.get(id)?.passport.name ?? id;

  // Every action that changes data, of every agent, the mailbox and the connected systems.
  function actions(): ApprovalRulesResponse['actions'] {
    const out = new Map<string, ApprovalRulesResponse['actions'][number]>();
    for (const rt of deps.registry.agents) for (const [target, a] of Object.entries(agentActions(rt))) if (!a.readOnly) out.set(target, { target, title: a.title, system: null });
    for (const [target, a] of Object.entries(deps.extraActions())) if (!a.readOnly) out.set(target, { target, title: a.title, system: a.system ?? null });
    return [...out.values()].sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  }

  app.get('/app/api/admin/approval-rules', agents, async (c) => {
    const known = actions();
    const rules = (await listRules(db)).map((r) => ({ ...r, id: String(r.id), title: known.find((a) => a.target === r.target)?.title ?? null }));
    return c.json({ rules, actions: known } satisfies ApprovalRulesResponse);
  });
  app.post('/app/api/admin/approval-rules', agents, async (c) => c.json(await saveRule(db, access(c).userId, null, await parseJson(c, approvalRuleInputSchema)), 201));
  app.put('/app/api/admin/approval-rules/:id', agents, async (c) => c.json(await saveRule(db, access(c).userId, c.req.param('id'), await parseJson(c, approvalRuleInputSchema))));
  app.delete('/app/api/admin/approval-rules/:id', agents, async (c) => {
    await deleteRule(db, access(c).userId, c.req.param('id'));
    return c.json({ ok: true });
  });
  app.put('/app/api/admin/departments/:id/heads', requirePermission('departments'), async (c) => {
    const { userIds } = await parseJson(c, departmentHeadsSchema);
    await setDepartmentHeads(db, access(c).userId, c.req.param('id'), userIds);
    return c.json({ ok: true });
  });

  // The card of «Да»: the stages of the call, by their names, for the person asking.
  app.post('/app/api/approval-chains/preview', async (c) => {
    const { tool } = await parseJson(c, previewSchema);
    const rules = await rulesFor(db, tool);
    if (rules.length === 0) return c.json({ stages: null } satisfies ChainPreviewResponse);
    const stages = await resolveStages(db, access(c).userId, rules.flatMap((r) => r.stages));
    return c.json({ stages: stages.map((s) => (s.self ? `${s.name} — вы сами (этап пройден)` : s.name)) } satisfies ChainPreviewResponse);
  });

  app.post('/app/api/approval-chains/reason', async (c) => {
    const { toolCallId, comment } = await parseJson(c, chainReasonSchema);
    await db.query(
      `INSERT INTO app.approval_chain_reasons (user_id, tool_call_id, comment) VALUES ($1, $2, $3) ON CONFLICT (user_id, tool_call_id) DO UPDATE SET comment = $3, created_at = now()`,
      [access(c).userId, toolCallId, comment],
    );
    return c.json({ ok: true });
  });

  app.get('/app/api/approval-chains', async (c) => {
    const userId = access(c).userId;
    const forMe = await db.query<ChainRow>(`SELECT * FROM app.approval_chains WHERE status = 'pending' AND user_id <> $1 AND stages -> (stage - 1) ? $1 ORDER BY created_at`, [userId]);
    const mine = await db.query<ChainRow>(`SELECT * FROM app.approval_chains WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${CHAINS_SHOWN}`, [userId]);
    const body: ChainsResponse = {
      forMe: await Promise.all(forMe.rows.map((r) => chainDto(db, box, r, userId, agentName))),
      mine: await Promise.all(mine.rows.map((r) => chainDto(db, box, r, userId, agentName))),
    };
    return c.json(body);
  });

  async function visible(id: string, userId: string): Promise<ChainRow> {
    const row = await chainRow(db, id);
    if (!row || !(await canSee(db, row, userId))) throw appError('APP_NOT_FOUND', `chain ${id} not visible to ${userId}`, { userMessage: 'Такой заявки нет.' });
    return row;
  }

  app.get('/app/api/approval-chains/:id', async (c) => {
    const userId = access(c).userId;
    return c.json(await chainDto(db, box, await visible(c.req.param('id'), userId), userId, agentName));
  });

  app.post('/app/api/approval-chains/:id/decision', async (c) => {
    const userId = access(c).userId;
    const { approve, reason } = await parseJson(c, chainDecisionSchema);
    const id = c.req.param('id');
    const last = await decideChain(db, id, userId, approve, reason);
    if (last) deps.executor.wake();
    const row = (await chainRow(db, id))!;
    // A decline ends the request: its line in the employee's conversation.
    if (row.status === 'declined') await deps.continuation.after(row, null, null);
    return c.json(await chainDto(db, box, row, userId, agentName));
  });

  app.post('/app/api/approval-chains/:id/withdraw', async (c) => {
    const userId = access(c).userId;
    await withdrawChain(db, c.req.param('id'), userId);
    return c.json(await chainDto(db, box, (await chainRow(db, c.req.param('id')))!, userId, agentName));
  });

  // «Повторить выполнение» of a request agreed but not done: within 72 hours, without new approvals.
  app.post('/app/api/approval-chains/:id/retry', async (c) => {
    const userId = access(c).userId;
    const { rowCount } = await db.query(
      `UPDATE app.approval_chains SET status = 'executing', call_started_at = NULL, error_code = NULL, finished_at = NULL WHERE id = $1 AND user_id = $2 AND status = 'failed' AND retry_until > now()`,
      [c.req.param('id'), userId],
    );
    if (!rowCount) throw appError('APP_APPROVAL_DECIDED', `chain ${c.req.param('id')} cannot be retried`, { userMessage: 'Повторить нельзя: заявка не ваша, уже выполнена или прошло 72 часа.' });
    deps.executor.wake();
    return c.json(await chainDto(db, box, (await chainRow(db, c.req.param('id')))!, userId, agentName));
  });
}
