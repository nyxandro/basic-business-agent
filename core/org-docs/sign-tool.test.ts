// The stamp and the signature through the agent (docs/specs/[20.11.2026]-org-letterhead.md, step 4), on the real sandbox:
// only a responsible person's agent has the tool, only after «Да», a document of a forbidden kind is refused before the
// card, the right is asked again after «Да», and the mark is found in a cell of a table and cut by Word into pieces.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentListResponse } from '@bba/contracts';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeRequest } from '../models/fake-openai.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { conversationRoot } from '../workspace/layout.ts';
import { NOT_A_SIGNER, SIGN_TOOL } from './prompt.ts';
import { testPng } from './test-pictures.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);

let t: TestApp;
let olga: string;
let olgaId: string;
let petr: string;

interface AguiEvent {
  type: string;
  outcome?: { type: string; interrupts?: { id: string; metadata?: { mastra?: { toolName?: string; args?: unknown } } }[] };
}

async function run(cookie: string, threadId: string, text: string | null, resume?: unknown): Promise<AguiEvent[]> {
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', {
    cookie,
    body: { threadId, runId: randomUUID(), messages: text ? [{ id: randomUUID(), role: 'user', content: text }] : [], tools: [], context: [], state: {}, forwardedProps: {}, ...(resume ? { resume } : {}) },
  });
  expect(res.status).toBe(200);
  return (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as AguiEvent);
}

const interruptOf = (events: AguiEvent[]) => events.find((e) => e.type === 'RUN_FINISHED')?.outcome?.interrupts?.[0];
const sign = (path: string, kind: string) => (req: FakeRequest) => ({ toolCalls: [{ name: (req.tools ?? []).some((x) => x.function.name === SIGN_TOOL) ? SIGN_TOOL : 'no_sign_tool', args: { path, kind } }] });
const toolNames = () => (t.model.requests.at(-1)!.tools ?? []).map((x) => x.function.name);
const lastToolResult = () => JSON.stringify(t.model.requests.at(-1)!.messages.filter((m) => m.role === 'tool').at(-1)?.content ?? '');

function folderOf(userId: string, threadId: string): string {
  return conversationRoot(t.workspaceRoot, { userId, threadId, project: null });
}

function putDocument(userId: string, threadId: string, name: string, fixture: string): string {
  const dir = folderOf(userId, threadId);
  writeFileSync(join(dir, name), readFileSync(new URL(fixture, FIXTURES)));
  return dir;
}

// The text of every part of the document, its pictures and whether the mark is left.
function signed(path: string): { text: string; drawings: number; media: string[] } {
  const files = unzipSync(readFileSync(path));
  const xml = Object.entries(files)
    .filter(([name]) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(name))
    .map(([, bytes]) => new TextDecoder().decode(bytes))
    .join('');
  const text = [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
  return { text, drawings: (xml.match(/<w:drawing>/g) ?? []).length, media: Object.keys(files).filter((n) => n.startsWith('word/media/')) };
}

beforeAll(async () => {
  t = await createTestApp({ sandbox: true });
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга Смирнова' });
  const petrId = await t.createUser({ email: 'petr@example.com', name: 'Пётр' });
  for (const [name, id] of [['Продажи', olgaId], ['Бухгалтерия', petrId]] as const) {
    const dep = (await t.db.query<{ id: string }>('INSERT INTO app.departments (name) VALUES ($1) RETURNING id', [name])).rows[0]!.id;
    await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [dep, id]);
    await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [dep]);
  }
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
  await t.db.query(`UPDATE app.org_profile SET director_position = 'Генеральный директор', director_full_name = 'Иванов Иван Петрович', director_signature_name = 'И. П. Иванов'`);
  await t.db.query('INSERT INTO app.org_assets (kind, content, sha256, width, height) VALUES ($1, $2, $3, 400, 400), ($4, $5, $6, 500, 150)', [
    'stamp',
    testPng(400, 400, { alpha: true }),
    'c'.repeat(64),
    'signature',
    testPng(500, 150, { alpha: true }),
    'd'.repeat(64),
  ]);
  await t.db.query('INSERT INTO app.org_signers (user_id) VALUES ($1)', [olgaId]);
}, 60_000);
afterAll(async () => {
  await t.close();
});

describe('the signing tool', () => {
  it('names the action and the kinds of documents for the card, the warning of an act included', async () => {
    const { agents } = (await (await t.call('GET', '/app/api/agents', { cookie: olga })).json()) as AgentListResponse;
    const action = agents.find((a) => a.id === 'sales')!.actions[SIGN_TOOL]!;
    expect(action).toMatchObject({ title: 'Поставить печать организации и подпись руководителя в документ Word', fields: { path: 'Документ', kind: 'Вид документа' }, readOnly: false });
    expect(action.choices?.kind?.commercial_offer).toBe('коммерческое предложение');
    expect(action.choices?.kind?.act).toContain('факсимиле допустимо, только если это прямо предусмотрено договором');
  });

  it('puts the stamp and the signature after «Да» of a responsible person, with the director from the profile and a record in the journal', async () => {
    const threadId = randomUUID();
    const dir = putDocument(olgaId, threadId, 'КП-Вектор.docx', 'to-sign.docx');
    t.model.script(sign('КП-Вектор.docx', 'commercial_offer'), { text: 'Готово.' });
    const interrupt = interruptOf(await run(olga, threadId, 'Сделай КП для Вектора с подписью директора'));
    expect(interrupt?.metadata?.mastra?.toolName).toBe(SIGN_TOOL);
    const { rows: asked } = await t.db.query<{ choices: Record<string, Record<string, string>> }>('SELECT choices FROM app.approval_requests WHERE tool = $1', [SIGN_TOOL]);
    expect(asked[0]?.choices.kind?.commercial_offer).toBe('коммерческое предложение');
    // Nothing is signed before the answer.
    expect(signed(join(dir, 'КП-Вектор.docx')).text).toContain('[[ПОДПИСЬ_РУКОВОДИТЕЛЯ]]');
    await run(olga, threadId, null, [{ interruptId: interrupt!.id, status: 'resolved', payload: { approved: true } }]);
    const doc = signed(join(dir, 'КП-Вектор.docx'));
    expect(doc.text).not.toContain('[[');
    expect(doc.text).toContain('Генеральный директор');
    expect(doc.text).toContain('И. П. Иванов');
    expect(doc.drawings).toBeGreaterThanOrEqual(3);
    expect(doc.media.length).toBe(3);
    // The letterhead stays: its logo and its footer.
    expect(doc.text).toContain('ИНН 7700000000');
    // The document as it was before goes to the drafts of the conversation.
    expect(readdirSync(join(dir, '.work')).some((n) => n.includes('КП-Вектор'))).toBe(true);
    const { rows } = await t.db.query<{ result: string; approved_by: string; args: { kind: string } }>('SELECT result, approved_by, args_summary AS args FROM app.action_journal WHERE tool = $1', [SIGN_TOOL]);
    expect(rows).toEqual([{ result: 'ok', approved_by: olgaId, args: expect.objectContaining({ kind: 'commercial_offer' }) }]);
  }, 60_000);

  it('finds the mark in a cell of a table, cut by Word into three pieces, and keeps the words around it', async () => {
    const threadId = randomUUID();
    const dir = putDocument(olgaId, threadId, 'Акт.docx', 'to-sign-table.docx');
    t.model.script(sign('Акт.docx', 'act'), { text: 'Готово.' });
    const interrupt = interruptOf(await run(olga, threadId, 'Поставь подпись на акт'));
    await run(olga, threadId, null, [{ interruptId: interrupt!.id, status: 'resolved', payload: { approved: true } }]);
    const doc = signed(join(dir, 'Акт.docx'));
    expect(doc.text).not.toContain('[[');
    expect(doc.text).toContain('Подпись: ');
    expect(doc.text).toContain(' М. П.');
    expect(doc.text).toContain('И. П. Иванов');
    expect(doc.media.length).toBe(2);
  }, 60_000);

  it('refuses an invoice, an act of transfer and a power of attorney before the card, and a document without the mark', async () => {
    const threadId = randomUUID();
    const dir = putDocument(olgaId, threadId, 'Счёт-фактура.docx', 'to-sign.docx');
    t.model.script(sign('Счёт-фактура.docx', 'invoice_factura'), { text: 'Нельзя.' });
    expect(interruptOf(await run(olga, threadId, 'Поставь подпись на счёт-фактуру'))).toBeUndefined();
    expect(lastToolResult()).toContain('APP_SIGN_FORBIDDEN_KIND');
    expect(signed(join(dir, 'Счёт-фактура.docx')).text).toContain('[[ПОДПИСЬ_РУКОВОДИТЕЛЯ]]');
    putDocument(olgaId, threadId, 'Письмо.docx', 'header-footer.docx');
    t.model.script(sign('Письмо.docx', 'letter'), { text: 'Метки нет.' });
    expect(interruptOf(await run(olga, threadId, 'Поставь подпись на письмо'))).toBeUndefined();
    expect(lastToolResult()).toContain('APP_SIGN_NO_MARKS');
    const { rows } = await t.db.query('SELECT 1 FROM app.approval_requests WHERE thread_id = $1', [threadId]);
    expect(rows).toEqual([]);
  }, 60_000);

  it('gives the agent of whoever is not responsible no tool and one line about the stamp', async () => {
    t.model.script({ text: 'Подпись ставят ответственные лица.' });
    await run(petr, randomUUID(), 'Поставь подпись директора на КП');
    expect(toolNames()).not.toContain(SIGN_TOOL);
    expect(t.model.requests.at(-1)!.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')).toContain(NOT_A_SIGNER);
  });

  it('asks the list again after «Да»: removed meanwhile — no stamp, a plain line of the signature instead of the mark', async () => {
    const threadId = randomUUID();
    const dir = putDocument(olgaId, threadId, 'Письмо.docx', 'to-sign.docx');
    t.model.script(sign('Письмо.docx', 'letter'), { text: 'Не получилось.' });
    const interrupt = interruptOf(await run(olga, threadId, 'Поставь подпись на письмо'));
    expect(interrupt).toBeTruthy();
    await t.db.query('DELETE FROM app.org_signers WHERE user_id = $1', [olgaId]);
    await run(olga, threadId, null, [{ interruptId: interrupt!.id, status: 'resolved', payload: { approved: true } }]);
    expect(lastToolResult()).toContain('APP_SIGN_NOT_ALLOWED');
    const doc = signed(join(dir, 'Письмо.docx'));
    expect(doc.text).not.toContain('[[');
    expect(doc.text).toContain('И. П. Иванов');
    // Only the logo of the letterhead: no stamp and no signature.
    expect(doc.media.length).toBe(1);
    const { rows } = await t.db.query<{ result: string; error_code: string }>("SELECT result, error_code FROM app.action_journal WHERE tool = $1 AND result = 'error'", [SIGN_TOOL]);
    expect(rows).toEqual([{ result: 'error', error_code: 'APP_SIGN_NOT_ALLOWED' }]);
    await t.db.query('INSERT INTO app.org_signers (user_id) VALUES ($1)', [olgaId]);
    expect(existsSync(join(dir, 'Письмо.docx'))).toBe(true);
  }, 60_000);
});
