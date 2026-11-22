// The facts of work (docs/specs/[20.11.2026]-feedback-and-value.md, step 6): a document only when the agent made it in
// this answer, once per file; a letter sent is `email`, not `action`; an answer that is an error object is nothing; the
// person's messages and new conversations are written for «работали с агентами»; removing a conversation keeps them.
import { randomUUID } from 'node:crypto';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applyApprovalPolicy } from '../approvals/policy.ts';
import type { ChainService } from '../approvals/chains.ts';
import type { AnyTool } from '../plugins/public/index.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';
import { createShowFileTool } from '../sandbox/show-file.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { chatRoot } from '../workspace/layout.ts';
import { createWorkFacts } from './facts.ts';

let t: TestApp;
let olgaId: string;
let olga: string;
let sales: string;

const factsOf = async (userId: string) => (await t.db.query<{ kind: string; department_ids: string[] }>('SELECT kind, department_ids FROM app.work_facts WHERE user_id = $1 ORDER BY id', [userId])).rows;
const clear = () => t.db.query('DELETE FROM app.work_facts');

function contextOf(threadId: string, startedAt: number): RequestContext {
  const rc = new RequestContext();
  rc.set(REQUEST_KEYS.userId, olgaId);
  rc.set(REQUEST_KEYS.agentId, 'sales');
  rc.set(REQUEST_KEYS.threadId, threadId);
  rc.set(REQUEST_KEYS.runKind, 'chat');
  rc.set(REQUEST_KEYS.runStartedAt, String(startedAt));
  return rc;
}

beforeAll(async () => {
  t = await createTestApp();
  sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [sales]);
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга', departmentIds: [sales] });
  olga = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('facts of work', () => {
  it('count a document the agent made in this answer once, never the person’s attachment', async () => {
    await clear();
    const threadId = randomUUID();
    const folder = chatRoot(t.workspaceRoot, olgaId, threadId);
    mkdirSync(folder, { recursive: true });
    const started = Date.now();
    // The attachment came before the answer started.
    writeFileSync(join(folder, 'Прайс.xlsx'), 'прайс');
    utimesSync(join(folder, 'Прайс.xlsx'), new Date(started - 60_000), new Date(started - 60_000));
    writeFileSync(join(folder, 'КП.docx'), 'кп');
    writeFileSync(join(folder, 'заметка.txt'), 'не документ');
    const tool = createShowFileTool(t.workspaceRoot, createWorkFacts(t.db)) as unknown as { execute: (input: unknown, ctx: unknown) => Promise<{ made?: boolean }> };
    const ctx = { requestContext: contextOf(threadId, started) };
    expect((await tool.execute({ path: 'Прайс.xlsx' }, ctx)).made).toBe(false);
    expect((await tool.execute({ path: 'КП.docx' }, ctx)).made).toBe(true);
    await tool.execute({ path: 'КП.docx' }, ctx);
    expect((await tool.execute({ path: 'заметка.txt' }, ctx)).made).toBe(true);
    expect(await factsOf(olgaId)).toEqual([{ kind: 'document', department_ids: [sales] }]);
  });

  it('write a letter sent as `email`, another change as `action`, and nothing for an error answer or a reading', async () => {
    await clear();
    const chains = { rulesApply: () => Promise.resolve(false) } as unknown as ChainService;
    const make = (id: string, output: unknown, readOnly = false) =>
      applyApprovalPolicy(createTool({ id, description: id, inputSchema: z.object({}), execute: () => Promise.resolve(output) }) as AnyTool, { readOnly, db: t.db, chains }) as unknown as { execute: (input: unknown, ctx: unknown) => Promise<unknown> };
    const ctx = { requestContext: contextOf(randomUUID(), Date.now()), agent: { toolCallId: 'c1' } };
    await make('mailbox_send', { sent: true }).execute({}, ctx);
    await make('crm_update_deal', { ok: true }).execute({}, ctx);
    await make('crm_update_contact', { error: true, code: 'APP_X', message: 'нет' }).execute({}, ctx);
    await make('crm_find_deal', { deals: [] }, true).execute({}, ctx);
    expect((await factsOf(olgaId)).map((f) => f.kind)).toEqual(['email', 'action']);
  });

  it('write the person’s messages and new conversations, kept when the conversation is removed', async () => {
    await clear();
    const threadId = randomUUID();
    const send = async (text: string) => {
      t.model.script({ text: 'Готово.' });
      const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', { cookie: olga, body: { threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: text }], tools: [], context: [], state: {}, forwardedProps: {} } });
      expect(res.status).toBe(200);
      await res.text();
    };
    await send('Привет');
    await send('Ещё вопрос');
    expect((await factsOf(olgaId)).map((f) => f.kind)).toEqual(['conversation', 'message', 'message']);
    expect((await t.call('DELETE', `/app/api/threads/${threadId}`, { cookie: olga })).status).toBe(200);
    expect(await factsOf(olgaId)).toHaveLength(3);
  }, 30_000);
});
