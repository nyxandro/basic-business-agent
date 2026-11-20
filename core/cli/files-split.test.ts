// The one move to the folders of conversations (spec, section 8.33, step 161): what a conversation outside projects
// showed the person comes into its own folder under the same path, the agent's scripts into its drafts, the rest of
// the old shared folder goes; a conversation of a project and a file already in place are not touched.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectDto } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { draftResourceId, ensureThread } from '../memory/memory.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { chatRoot, filesRoot } from '../workspace/layout.ts';
import { applyFilesSplit, planFilesSplit } from './files-split.ts';

let t: TestApp;
let olgaId: string;
let olga: string;

type Part = Record<string, unknown>;
const text = (value: string): Part => ({ type: 'text', text: value });
const call = (toolName: string, args: unknown, result: unknown): Part => ({ type: 'tool-invocation', toolInvocation: { state: 'result', toolCallId: randomUUID(), toolName, args, result } });
const attached = (words: string, paths: string[]) => text(`${words}\n\nВложения:\n${paths.map((p) => `- ${p.split('/').pop()} (файл в рабочей папке: ${p})`).join('\n')}`);
const shown = (path: string) => call('show_file', { path }, { shown: true, path, name: path.split('/').pop(), bytes: 3 });

let clock = Date.parse('2026-11-10T07:00:00Z');
async function conversation(resourceId: string, turns: [role: 'user' | 'assistant', parts: Part[]][]): Promise<string> {
  const threadId = randomUUID();
  await ensureThread(t.memory, { threadId, resourceId, agentId: 'sales', kind: 'chat', title: 'Разговор' });
  await t.memory.saveMessages({
    messages: turns.map(([role, parts]) => ({ id: randomUUID(), threadId, resourceId, role, createdAt: new Date((clock += 60_000)), content: { format: 2 as const, parts: parts as never } })),
  });
  return threadId;
}

const shared = () => filesRoot(t.workspaceRoot, olgaId, null);
function put(rel: string, content: string, modified?: Date) {
  const path = join(shared(), rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (modified) utimesSync(path, modified, modified);
}
const read = (threadId: string, rel: string) => readFileSync(join(chatRoot(t.workspaceRoot, olgaId, threadId), rel), 'utf8');

let kp: string;
let again: string;
let draft: string;
let inProject: string;
let fresh: string;
const OLD = new Date('2026-11-12T10:00:00Z');

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга Смирнова' });
  olga = await t.signIn('olga@example.com');

  put('Смета.xlsx', 'смета');
  put('КП.docx', 'кп', OLD);
  put('Почта/счёт.pdf', 'счёт');
  put('.marks/Пометки.jpg', 'пометки');
  put('make_kp.js', 'скрипт', OLD);
  put('.work/bld.js', 'черновик');
  put('Проект.docx', 'проект');
  put('Уже есть.docx', 'старый');
  put('мусор.png', 'мусор');
  put('.renders/page-1.png', 'страница');
  put('unpacked/word/document.xml', 'xml');
  writeFileSync(join(t.workspaceRoot, 'outside.txt'), 'чужое');
  symlinkSync(join(t.workspaceRoot, 'outside.txt'), join(shared(), 'Ярлык.docx'));

  kp = await conversation(olgaId, [
    ['user', [attached('Сделай КП по смете', ['Смета.xlsx'])]],
    ['assistant', [call('mastra_workspace_write_file', { path: 'make_kp.js', content: '…' }, 'ok'), call('mastra_workspace_edit_file', { path: '.work/bld.js' }, 'ok'), call('mastra_workspace_edit_file', { path: '.work/make_kp.js' }, 'ok'), shown('КП.docx'), text('Готово.')]],
    ['user', [attached('Вот пометки и счёт', ['.marks/Пометки.jpg', 'Почта/счёт.pdf'])]],
    ['assistant', [call('show_file', { path: 'Нет такого.docx' }, { shown: false, error: 'Файла нет' }), shown('Пропал.docx'), shown('../outside.txt'), shown('Ярлык.docx'), text('Не вышло.')]],
  ]);
  again = await conversation(olgaId, [['assistant', [shown('КП.docx')]]]);
  draft = await conversation(draftResourceId(olgaId), [['user', [attached('Проверка промпта', ['Смета.xlsx'])]]]);
  inProject = await conversation(olgaId, [['assistant', [shown('Проект.docx')]]]);
  const res = await t.call('POST', '/app/api/projects', { cookie: olga, body: { name: 'Кровля', access: { mode: 'private', departmentIds: [], userIds: [] } } });
  await t.db.query('INSERT INTO app.thread_projects (thread_id, user_id, project_id) VALUES ($1, $2, $3)', [inProject, olgaId, ((await res.json()) as ProjectDto).id]);
  fresh = await conversation(olgaId, [['assistant', [shown('Уже есть.docx')]]]);
  mkdirSync(chatRoot(t.workspaceRoot, olgaId, fresh), { recursive: true });
  writeFileSync(join(chatRoot(t.workspaceRoot, olgaId, fresh), 'Уже есть.docx'), 'новый');
});
afterAll(() => t?.close());

describe('pnpm files:split', () => {
  it('plans without touching a file', async () => {
    const plan = await planFilesSplit(t.db, t.workspaceRoot);
    const olgas = plan.users.find((u) => u.userId === olgaId)!;
    expect(olgas.copies.map((c) => [c.threadId, c.from, c.to, c.kind]).sort()).toEqual(
      [
        [kp, 'Смета.xlsx', `chats/${kp}/Смета.xlsx`, 'shown'],
        [kp, 'КП.docx', `chats/${kp}/КП.docx`, 'shown'],
        [kp, '.marks/Пометки.jpg', `chats/${kp}/.marks/Пометки.jpg`, 'shown'],
        [kp, 'Почта/счёт.pdf', `chats/${kp}/Почта/счёт.pdf`, 'shown'],
        [kp, 'make_kp.js', `chats/${kp}/.work/make_kp.js`, 'draft'],
        [kp, '.work/bld.js', `chats/${kp}/.work/bld.js`, 'draft'],
        [again, 'КП.docx', `chats/${again}/КП.docx`, 'shown'],
        [draft, 'Смета.xlsx', `chats/${draft}/Смета.xlsx`, 'shown'],
      ].sort(),
    );
    expect(olgas.inPlace).toEqual([`chats/${fresh}/Уже есть.docx`]);
    // A link is not a file of the folder: it is not followed, wherever it leads.
    expect(olgas.missing.sort()).toEqual(['Пропал.docx', 'Ярлык.docx']);
    expect(olgas.removed.sort()).toEqual(['.marks', '.renders', '.work', 'make_kp.js', 'unpacked', 'Почта', 'Проект.docx', 'КП.docx', 'мусор.png', 'Смета.xlsx', 'Уже есть.docx', 'Ярлык.docx'].sort());
    expect(readdirSync(shared()).sort()).toEqual(['.marks', '.renders', '.work', 'chats', 'make_kp.js', 'unpacked', 'Почта', 'Проект.docx', 'КП.docx', 'мусор.png', 'Смета.xlsx', 'Уже есть.docx', 'Ярлык.docx'].sort());
    expect(existsSync(chatRoot(t.workspaceRoot, olgaId, kp))).toBe(false);
  });

  it('gives each conversation what it showed, keeps what is in place, leaves only the folders of conversations', async () => {
    applyFilesSplit(t.workspaceRoot, await planFilesSplit(t.db, t.workspaceRoot));
    expect(read(kp, 'Смета.xlsx')).toBe('смета');
    expect(read(kp, 'КП.docx')).toBe('кп');
    expect(read(kp, 'Почта/счёт.pdf')).toBe('счёт');
    expect(read(kp, '.marks/Пометки.jpg')).toBe('пометки');
    expect(read(kp, '.work/make_kp.js')).toBe('скрипт');
    expect(read(kp, '.work/bld.js')).toBe('черновик');
    expect(read(again, 'КП.docx')).toBe('кп');
    expect(read(draft, 'Смета.xlsx')).toBe('смета');
    expect(read(fresh, 'Уже есть.docx')).toBe('новый');
    // The age of a script stays its own: the drafts are cleaned by it.
    expect(statSync(join(chatRoot(t.workspaceRoot, olgaId, kp), '.work/make_kp.js')).mtime).toEqual(OLD);
    expect(existsSync(chatRoot(t.workspaceRoot, olgaId, inProject))).toBe(false);
    expect(readdirSync(shared())).toEqual(['chats']);
    expect(readFileSync(join(t.workspaceRoot, 'outside.txt'), 'utf8')).toBe('чужое');
  });

  it('has nothing left to do the second time', async () => {
    const plan = await planFilesSplit(t.db, t.workspaceRoot);
    expect(plan.users.find((u) => u.userId === olgaId)).toMatchObject({ copies: [], removed: [] });
  });

  it('never writes through a link an agent made in the folder of a conversation, and then removes nothing', async () => {
    put('Почта/акт.pdf', 'акт');
    const mail = await conversation(olgaId, [['user', [attached('Вот акт', ['Почта/акт.pdf'])]]]);
    const outside = join(t.workspaceRoot, 'снаружи');
    mkdirSync(outside);
    mkdirSync(chatRoot(t.workspaceRoot, olgaId, mail), { recursive: true });
    symlinkSync(outside, join(chatRoot(t.workspaceRoot, olgaId, mail), 'Почта'));
    const plan = await planFilesSplit(t.db, t.workspaceRoot);
    expect(() => applyFilesSplit(t.workspaceRoot, plan)).toThrow(/APP_FILES_SPLIT_FAILED/);
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(join(shared(), 'Почта/акт.pdf'), 'utf8')).toBe('акт');
  });

  it('refuses while the files are in a bucket', async () => {
    await t.db.query(
      `UPDATE app.storage_settings SET mode = 's3', provider = 'other', endpoint = 'https://s3.example.com', region = 'ru-1', bucket = 'files', path_style = true,
              ciphertext = '\\x00', iv = '\\x00', key_version = 1`,
    );
    try {
      await expect(planFilesSplit(t.db, t.workspaceRoot)).rejects.toThrow(/APP_FILES_SPLIT_BUCKET/);
    } finally {
      await t.db.query(`UPDATE app.storage_settings SET mode = 'local', provider = NULL, endpoint = NULL, region = NULL, bucket = NULL, path_style = NULL, ciphertext = NULL, iv = NULL, key_version = NULL`);
    }
  });
});
