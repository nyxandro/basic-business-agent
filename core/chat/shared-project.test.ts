// A colleague's agent in a shared project (spec, section 8.20): it works in the folder of the
// project's creator with the project's instructions; access closed in the middle of an answer does
// not stop that answer; the next one works without the project and the agent is told why.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectDto, TrashBatchDto } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeRequest } from '../models/fake-openai.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { contextRoot } from '../workspace/layout.ts';

let t: TestApp;
let olgaId: string;
let petrId: string;
let olga: string;
let petr: string;

interface AguiEvent {
  type: string;
  delta?: string;
  outcome?: { interrupts?: { id: string }[] };
}

async function events(cookie: string, threadId: string, text: string | null, resume?: unknown): Promise<AguiEvent[]> {
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', {
    cookie,
    body: { threadId, runId: randomUUID(), messages: text ? [{ id: randomUUID(), role: 'user', content: text }] : [], tools: [], context: [], state: {}, forwardedProps: {}, ...(resume ? { resume } : {}) },
  });
  const body = await res.text();
  expect(res.status).toBe(200);
  return body
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as AguiEvent);
}

async function run(cookie: string, threadId: string, text: string): Promise<string> {
  return (await events(cookie, threadId, text))
    .filter((e) => e.type === 'TEXT_MESSAGE_CHUNK' || e.type === 'TEXT_MESSAGE_CONTENT')
    .map((e) => e.delta ?? '')
    .join('');
}

const tool = (suffix: string, args: Record<string, unknown>) => (req: FakeRequest) => ({
  toolCalls: [{ name: (req.tools ?? []).map((x) => x.function.name).find((n) => n.endsWith(suffix)) ?? `missing_${suffix}`, args }],
});
const systemOf = (req: FakeRequest) => JSON.stringify(req.messages.filter((m) => m.role === 'system'));
const lastToolOutput = (req: FakeRequest) => JSON.stringify(req.messages.filter((m) => m.role === 'tool').at(-1)?.content ?? '');
const share = (projectId: string, userIds: string[]) =>
  t.call('PUT', `/app/api/projects/${projectId}/access`, { cookie: olga, body: userIds.length ? { mode: 'list', departmentIds: [], userIds } : { mode: 'private', departmentIds: [], userIds: [] } });

beforeAll(async () => {
  t = await createTestApp({ sandbox: true });
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга Смирнова' });
  petrId = await t.createUser({ email: 'petr@example.com', name: 'Пётр Иванов' });
  const dep = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2), ($1, $3)', [dep, olgaId, petrId]);
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [dep]);
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('a colleague’s agent in a shared project', () => {
  it('reads the creator’s files with the project’s instructions; closed access mid-answer lets the answer finish; the next one goes without the project', async () => {
    const created = await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Тендер', access: { mode: 'list', departmentIds: [], userIds: [petrId] } } });
    const project = (await created.json()) as ProjectDto;
    await t.call('PUT', `/app/api/projects/${project.id}`, { cookie: olga, body: { instructions: 'Заказчик — ООО Пример.' } });
    const folder = contextRoot(t.workspaceRoot, olgaId, project.id);
    writeFileSync(join(folder, 'договор.txt'), 'ДОГОВОР ПОСТАВКИ');
    const threadId = randomUUID();
    expect((await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: petr, body: { projectId: project.id } })).status).toBe(200);

    // 1. The colleague's agent sees the creator's file and the project.
    let seen: FakeRequest | null = null;
    t.model.script(tool('read_file', { path: 'договор.txt' }), (req) => ((seen = req), { text: 'Прочитал.' }));
    expect(await run(petr, threadId, 'Прочитай договор')).toBe('Прочитал.');
    expect(lastToolOutput(seen!)).toContain('ДОГОВОР ПОСТАВКИ');
    expect(systemOf(seen!)).toContain('# Проект «Тендер»');
    expect(systemOf(seen!)).toContain('Заказчик — ООО Пример.');
    expect(systemOf(seen!)).toContain('Проект общий, его открыл(а) тебе Ольга Смирнова');
    expect(existsSync(join(t.workspaceRoot, petrId, 'projects', project.id))).toBe(false);

    // 2. Access is closed while the command of the answer runs; the file is written after that, into the project.
    let closed = false;
    let closing: Promise<unknown> | null = null;
    t.model.script(
      (req) => {
        closing = share(project.id, []).then(() => (closed = true));
        return tool('execute_command', { command: 'sleep 1' })(req);
      },
      (req) => (closed ? tool('write_file', { path: 'КП.txt', content: 'КП для ООО Пример' })(req) : { text: 'доступ ещё не закрыт' }),
      { text: 'Готово.' },
    );
    expect(await run(petr, threadId, 'Сделай КП')).toBe('Готово.');
    await (closing as Promise<unknown> | null);
    expect(readFileSync(join(folder, 'КП.txt'), 'utf8')).toBe('КП для ООО Пример');

    // 3. The next answer: no project, the agent is told why; the creator's files are out of reach.
    let after: FakeRequest | null = null;
    t.model.script(tool('read_file', { path: 'договор.txt' }), (req) => ((after = req), { text: 'Не вижу.' }));
    expect(await run(petr, threadId, 'Ещё раз прочитай договор')).toBe('Не вижу.');
    expect(systemOf(after!)).not.toContain('# Проект «Тендер»');
    expect(systemOf(after!)).toContain('Этот разговор был в проекте «Тендер», но доступ к нему закрыт');
    expect(lastToolOutput(after!)).not.toContain('ДОГОВОР ПОСТАВКИ');

    // 4. «Скачать» of the project's file says why it is out of reach.
    const download = await t.call('GET', `/app/api/threads/${threadId}/file?path=${encodeURIComponent('КП.txt')}`, { cookie: petr });
    expect(download.status).toBe(404);
    expect(await download.json()).toMatchObject({ error: { code: 'APP_PROJECT_ACCESS_LOST', message: 'Файл лежит в проекте «Тендер», к которому у вас больше нет доступа.' } });

    // 5. Open again: the conversation is back in the project.
    await share(project.id, [petrId]);
    let back: FakeRequest | null = null;
    t.model.script((req) => ((back = req), { text: 'Снова в проекте.' }));
    await run(petr, threadId, 'Ты снова в проекте?');
    expect(systemOf(back!)).toContain('# Проект «Тендер»');
  });
  it('an answer waiting for «Да» when access is closed is finished in the project; the next one goes without it', async () => {
    const created = await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Письма', access: { mode: 'list', departmentIds: [], userIds: [petrId] } } });
    const project = (await created.json()) as ProjectDto;
    const folder = contextRoot(t.workspaceRoot, olgaId, project.id);
    writeFileSync(join(folder, 'КП.txt'), 'КП для клиента');
    const threadId = randomUUID();
    await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: petr, body: { projectId: project.id } });
    t.model.script({ toolCalls: [{ name: 'mail_send', args: { to: 'client@example.com', text: 'КП во вложении' } }] });
    const first = await events(petr, threadId, 'Отправь КП клиенту и проверь файл');
    const interrupt = first.find((e) => e.type === 'RUN_FINISHED')?.outcome?.interrupts?.[0];
    expect(interrupt).toBeDefined();

    await share(project.id, []);
    // After «Да» the same answer goes on: in the project's folder, the file is there.
    let resumed: FakeRequest | null = null;
    t.model.script(tool('read_file', { path: 'КП.txt' }), (req) => ((resumed = req), { text: 'Письмо ушло, файл на месте.' }));
    await events(petr, threadId, null, [{ interruptId: interrupt!.id, status: 'resolved', payload: { approved: true } }]);
    expect(t.sentMail).toContainEqual({ to: 'client@example.com', text: 'КП во вложении' });
    expect(lastToolOutput(resumed!)).toContain('КП для клиента');

    // The next message is a new answer: without the project, the agent is told why.
    let next: FakeRequest | null = null;
    t.model.script((req) => ((next = req), { text: 'Проекта больше нет.' }));
    await run(petr, threadId, 'Что с проектом?');
    expect(systemOf(next!)).not.toContain('# Проект «Письма»');
    expect(systemOf(next!)).toContain('Этот разговор был в проекте «Письма», но доступ к нему закрыт');
  });
  it('what the colleague’s agent removes with a command goes into the project’s trash', async () => {
    const created = await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Корзина', access: { mode: 'list', departmentIds: [], userIds: [petrId] } } });
    const project = (await created.json()) as ProjectDto;
    writeFileSync(join(contextRoot(t.workspaceRoot, olgaId, project.id), 'смета.xlsx'), 'СМЕТА');
    const threadId = randomUUID();
    await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: petr, body: { projectId: project.id } });
    t.model.script(tool('execute_command', { command: 'rm смета.xlsx' }), { text: 'Убрал лишнее.' });
    expect(await run(petr, threadId, 'Убери лишнее из папки')).toBe('Убрал лишнее.');
    // The trash is filled right after the answer ends.
    const trash = async () => ((await (await t.call('GET', `/app/api/projects/${project.id}/trash`, { cookie: olga })).json()) as { batches: TrashBatchDto[] }).batches;
    for (let i = 0; i < 50 && (await trash()).length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await trash()).toMatchObject([{ via: 'agent', deletedBy: 'Пётр Иванов', items: [{ path: 'смета.xlsx', kind: 'deleted' }] }]);
  });
  // CopilotKit lets the agent finish without the browser: what it removes after the tab is gone still
  // reaches the trash (independent review 16.11).
  it('what the agent removes after the browser went away still goes into the trash', async () => {
    const created = await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Обрыв', access: { mode: 'private', departmentIds: [], userIds: [] } } });
    const project = (await created.json()) as ProjectDto;
    writeFileSync(join(contextRoot(t.workspaceRoot, olgaId, project.id), 'черновик.txt'), 'Ч');
    const threadId = randomUUID();
    await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: olga, body: { projectId: project.id } });
    t.model.script(tool('execute_command', { command: 'sleep 1; rm черновик.txt' }), { text: 'Убрал.' });
    const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', {
      cookie: olga,
      body: { threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: 'Убери черновик' }], tools: [], context: [], state: {}, forwardedProps: {} },
    });
    // The tab is closed right after the answer began.
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    const trash = async () => ((await (await t.call('GET', `/app/api/projects/${project.id}/trash`, { cookie: olga })).json()) as { batches: TrashBatchDto[] }).batches;
    for (let i = 0; i < 100 && (await trash()).length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect((await trash()).flatMap((b) => b.items.map((x) => x.path))).toEqual(['черновик.txt']);
  });
  // The whole chain, not a direct call: the agent's write_file over a file → the hook → the snapshot.
  it('a file the agent writes over with its tool leaves its previous version in the trash', async () => {
    const created = await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Перезапись', access: { mode: 'private', departmentIds: [], userIds: [] } } });
    const project = (await created.json()) as ProjectDto;
    const folder = contextRoot(t.workspaceRoot, olgaId, project.id);
    writeFileSync(join(folder, 'смета.txt'), 'СТАРАЯ СМЕТА');
    const threadId = randomUUID();
    await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: olga, body: { projectId: project.id } });
    t.model.script(tool('read_file', { path: 'смета.txt' }), tool('write_file', { path: 'смета.txt', content: 'НОВАЯ СМЕТА', overwrite: true }), { text: 'Переписал.' });
    expect(await run(olga, threadId, 'Перепиши смету')).toBe('Переписал.');
    expect(readFileSync(join(folder, 'смета.txt'), 'utf8')).toBe('НОВАЯ СМЕТА');
    const trash = async () => ((await (await t.call('GET', `/app/api/projects/${project.id}/trash`, { cookie: olga })).json()) as { batches: TrashBatchDto[] }).batches;
    for (let i = 0; i < 50 && (await trash()).length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    const [item] = (await trash()).flatMap((b) => b.items);
    expect(item).toMatchObject({ path: 'смета.txt', kind: 'previous_version' });
    const trashFolder = join(t.workspaceRoot, olgaId, 'projects', project.id, 'trash');
    expect(readFileSync(join(trashFolder, readdirSync(trashFolder)[0]!), 'utf8')).toBe('СТАРАЯ СМЕТА');
  });

  // The sandbox of a colleague is kept per project and its creator: a project given to the admin
  // (its creator removed) gets a new one in its new folder (independent review 16.11).
  it('a colleague’s commands work in a project given to the admin after its creator was removed', async () => {
    const igorId = await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
    const igor = await t.signIn('igor@example.com');
    const ninaId = await t.createUser({ email: 'nina@example.com', name: 'Нина' });
    const nina = await t.signIn('nina@example.com');
    const created = await t.call('POST', '/app/api/projects', { cookie: nina, body: { name: 'Передача', access: { mode: 'list', departmentIds: [], userIds: [petrId] } } });
    const project = (await created.json()) as ProjectDto;
    writeFileSync(join(contextRoot(t.workspaceRoot, ninaId, project.id), 'план.txt'), 'П');
    const threadId = randomUUID();
    await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: petr, body: { projectId: project.id } });
    let seen: FakeRequest | null = null;
    t.model.script(tool('execute_command', { command: 'ls' }), (req) => ((seen = req), { text: 'Есть.' }));
    await run(petr, threadId, 'Что в папке?');
    expect(lastToolOutput(seen!)).toContain('план.txt');
    expect((await t.call('DELETE', `/app/api/admin/users/${ninaId}`, { cookie: igor })).status).toBe(200);
    expect(existsSync(join(t.workspaceRoot, igorId, 'projects', project.id, 'files', 'план.txt'))).toBe(true);
    t.model.script(tool('execute_command', { command: 'ls' }), (req) => ((seen = req), { text: 'Всё ещё есть.' }));
    await run(petr, threadId, 'А теперь?');
    expect(lastToolOutput(seen!)).toContain('план.txt');
  });
});
