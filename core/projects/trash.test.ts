// The trash of a project (spec, section 8.20): a file removed by the page or by the agent in any way
// lies there 30 days and comes back to its place; a file replaced by a new one leaves its previous
// version; a trash item of an answer is one batch; the trash empties itself.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProjectDto, ThreadFileStatus, TrashBatchDto } from '@bba/contracts';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureThread } from '../memory/memory.ts';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';
import { contextRoot } from '../workspace/layout.ts';
import { keepBeforeWrite, purgeTrash, recoverProjectFolders, settleSnapshot, takeSnapshot, trashDir } from './trash.ts';

let t: TestApp;
let olgaId: string;
let petrId: string;
let olga: string;
let petr: string;

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

async function project(name: string, shareTo: string[] = []): Promise<{ id: string; files: string }> {
  const access = shareTo.length ? { mode: 'list', departmentIds: [], userIds: shareTo } : { mode: 'private', departmentIds: [], userIds: [] };
  const p = await json<ProjectDto>(await t.call('POST', '/app/api/projects', { cookie: olga, body: { name, access } }));
  return { id: p.id, files: contextRoot(t.workspaceRoot, olgaId, p.id) };
}

function put(folder: string, path: string, text: string): void {
  mkdirSync(dirname(join(folder, path)), { recursive: true });
  writeFileSync(join(folder, path), text);
}

const trashOf = async (projectId: string, cookie = olga) => (await json<{ batches: TrashBatchDto[] }>(await t.call('GET', `/app/api/projects/${projectId}/trash`, { cookie }))).batches;
const restore = (projectId: string, body: unknown, cookie = olga) => t.call('POST', `/app/api/projects/${projectId}/trash/restore`, { cookie, body });
const snapshotOf = (projectId: string) => takeSnapshot(t.workspaceRoot, { projectId, ownerId: olgaId, userId: petrId, threadId: 'thread-1' });

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга Смирнова' });
  petrId = await t.createUser({ email: 'petr@example.com', name: 'Пётр Иванов' });
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('the trash of a project', () => {
  it('takes a file removed by the page and gives it back to its place; a taken name gets «(2)»', async () => {
    const p = await project('Страница', [petrId]);
    put(p.files, 'сметы/смета.xlsx', 'v1');
    const removed = await t.call('DELETE', `/app/api/projects/${p.id}/file?path=${encodeURIComponent('сметы/смета.xlsx')}`, { cookie: petr });
    expect(removed.status).toBe(200);
    expect(existsSync(join(p.files, 'сметы/смета.xlsx'))).toBe(false);
    // The colleague sees the trash too (F6).
    const [batch] = await trashOf(p.id, petr);
    expect(batch).toMatchObject({ via: 'page', deletedBy: 'Пётр Иванов', items: [{ path: 'сметы/смета.xlsx', bytes: 2, kind: 'deleted' }] });
    const days = (Date.parse(batch!.items[0]!.expiresAt) - Date.parse(batch!.deletedAt)) / 86_400_000;
    expect(days).toBe(30);

    put(p.files, 'сметы/смета.xlsx', 'новая');
    const back = await json<{ restored: string[] }>(await restore(p.id, { ids: [batch!.items[0]!.id] }, petr));
    expect(back.restored).toEqual(['сметы/смета (2).xlsx']);
    expect(readFileSync(join(p.files, 'сметы/смета (2).xlsx'), 'utf8')).toBe('v1');
    expect(await trashOf(p.id)).toEqual([]);
    const again = await restore(p.id, { ids: [batch!.items[0]!.id] });
    expect(again.status).toBe(404);
    expect((await json<{ error: { message: string } }>(again)).error.message).toBe('Этого файла в корзине уже нет. Список обновлён.');
  });

  it('takes what an answer removed in any way, as one batch: not a renamed file, not a draft of the answer', async () => {
    const p = await project('Ответ агента');
    put(p.files, 'договор.pdf', 'Д');
    put(p.files, 'прайс.xlsx', 'П');
    put(p.files, 'старое/акт.docx', 'А');
    put(p.files, '.renders/стр-1.png', 'R');
    const snapshot = snapshotOf(p.id);
    rmSync(join(p.files, 'договор.pdf'));
    renameSync(join(p.files, 'прайс.xlsx'), join(p.files, 'прайс 2026.xlsx'));
    rmSync(join(p.files, 'старое'), { recursive: true });
    rmSync(join(p.files, '.renders'), { recursive: true });
    put(p.files, 'черновик.js', 'x');
    rmSync(join(p.files, 'черновик.js'));
    expect(await settleSnapshot(t.db, t.workspaceRoot, snapshot)).toBe(2);
    const batches = await trashOf(p.id);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ id: snapshot.id, via: 'agent', deletedBy: 'Пётр Иванов' });
    expect(batches[0]!.items.map((i) => i.path).sort()).toEqual(['договор.pdf', 'старое/акт.docx']);
    expect(existsSync(join(t.workspaceRoot, olgaId, 'projects', p.id, '.snapshots', snapshot.id))).toBe(false);

    expect((await json<{ restored: string[] }>(await restore(p.id, { batchId: snapshot.id }))).restored.sort()).toEqual(['договор.pdf', 'старое/акт.docx']);
    expect(readFileSync(join(p.files, 'старое/акт.docx'), 'utf8')).toBe('А');
  });

  it('keeps the previous version of a file replaced by a new one, and of one the agent’s tools write over', async () => {
    const p = await project('Версии');
    put(p.files, 'кп.docx', 'старое КП');
    put(p.files, 'смета.xlsx', 'старая смета');
    put(p.files, 'заметки.txt', 'было');
    const snapshot = snapshotOf(p.id);
    // A program that saves a new file and puts it in place of the old one.
    writeFileSync(join(p.files, 'кп.docx.tmp'), 'новое КП');
    renameSync(join(p.files, 'кп.docx.tmp'), join(p.files, 'кп.docx'));
    // The agent's write_file: the hook copies first, then the file is written in place.
    keepBeforeWrite(t.workspaceRoot, snapshot, ['смета.xlsx', join(p.files, 'смета.xlsx')]);
    writeFileSync(join(p.files, 'смета.xlsx'), 'новая смета');
    // A script writing in place, with no hook: its previous version is not kept (a known limit).
    writeFileSync(join(p.files, 'заметки.txt'), 'стало');
    await settleSnapshot(t.db, t.workspaceRoot, snapshot);
    const [batch] = await trashOf(p.id);
    expect(batch!.items.map((i) => [i.path, i.kind]).sort()).toEqual([
      ['кп.docx', 'previous_version'],
      ['смета.xlsx', 'previous_version'],
    ]);
    const back = await json<{ restored: string[] }>(await restore(p.id, { batchId: batch!.id }));
    expect(back.restored.sort()).toEqual(['кп (прежняя версия).docx', 'смета (прежняя версия).xlsx']);
    expect(readFileSync(join(p.files, 'кп (прежняя версия).docx'), 'utf8')).toBe('старое КП');
    expect(readFileSync(join(p.files, 'кп.docx'), 'utf8')).toBe('новое КП');
    expect(readFileSync(join(p.files, 'смета (прежняя версия).xlsx'), 'utf8')).toBe('старая смета');
  });

  it('takes a file two answers both removed once', async () => {
    const p = await project('Два ответа');
    put(p.files, 'общий.txt', 'О');
    const first = snapshotOf(p.id);
    const second = snapshotOf(p.id);
    rmSync(join(p.files, 'общий.txt'));
    await Promise.all([settleSnapshot(t.db, t.workspaceRoot, first), settleSnapshot(t.db, t.workspaceRoot, second)]);
    expect((await trashOf(p.id)).flatMap((b) => b.items)).toHaveLength(1);
  });

  it('empties itself after 30 days, the row and the file', async () => {
    const p = await project('Уборка');
    put(p.files, 'старый.txt', 'С');
    put(p.files, 'свежий.txt', 'Н');
    for (const name of ['старый.txt', 'свежий.txt']) await t.call('DELETE', `/app/api/projects/${p.id}/file?path=${encodeURIComponent(name)}`, { cookie: olga });
    const items = (await trashOf(p.id)).flatMap((b) => b.items);
    const old = items.find((i) => i.path === 'старый.txt')!;
    await t.db.query("UPDATE app.project_trash SET deleted_at = now() - interval '31 days', expires_at = now() - interval '1 day' WHERE id = $1", [old.id]);
    const purged = await purgeTrash(t.db, t.workspaceRoot);
    expect(purged.files).toBeGreaterThanOrEqual(1);
    expect((await trashOf(p.id)).flatMap((b) => b.items).map((i) => i.path)).toEqual(['свежий.txt']);
    expect(existsSync(join(trashDir(t.workspaceRoot, olgaId, p.id), old.id))).toBe(false);
  });

  it('at the start settles what a stopped server left, removes folders of gone projects and stray trash files', async () => {
    const p = await project('После сбоя');
    put(p.files, 'отчёт.pdf', 'О');
    const left = snapshotOf(p.id);
    rmSync(join(p.files, 'отчёт.pdf'));
    const stray = join(trashDir(t.workspaceRoot, olgaId, p.id), randomUUID());
    put(dirname(stray), stray.split('/').at(-1)!, 'x');
    const gone = join(t.workspaceRoot, olgaId, 'projects', randomUUID());
    put(gone, 'files/забытое.txt', 'x');
    await recoverProjectFolders(t.db, t.workspaceRoot);
    expect((await trashOf(p.id)).flatMap((b) => b.items).map((i) => i.path)).toEqual(['отчёт.pdf']);
    expect(existsSync(join(t.workspaceRoot, olgaId, 'projects', p.id, '.snapshots', left.id))).toBe(false);
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(gone)).toBe(false);
  });

  it('a project removed or given to another person meanwhile leaves no folder made again by the answer (F5)', async () => {
    const p = await project('Удалим посреди ответа');
    const snapshot = snapshotOf(p.id);
    await t.db.query('DELETE FROM app.projects WHERE id = $1', [p.id]);
    // The agent's tools wrote into the folder again after the removal.
    put(p.files, 'после.txt', 'x');
    await settleSnapshot(t.db, t.workspaceRoot, snapshot);
    expect(existsSync(join(t.workspaceRoot, olgaId, 'projects', p.id))).toBe(false);
  });

  it('«Скачать» of the chat says the file is in the trash, gone, or there', async () => {
    const p = await project('Скачать');
    const threadId = randomUUID();
    await ensureThread(t.memory, { threadId, resourceId: olgaId, agentId: 'sales', kind: 'chat', title: 'КП' });
    await t.call('PUT', `/app/api/threads/${threadId}/project`, { cookie: olga, body: { projectId: p.id } });
    put(p.files, 'КП v1.docx', 'КП');
    const status = async (path: string) => json<ThreadFileStatus>(await t.call('GET', `/app/api/threads/${threadId}/file/status?path=${encodeURIComponent(path)}`, { cookie: olga }));
    expect(await status('КП v1.docx')).toEqual({ state: 'ok' });
    await t.call('DELETE', `/app/api/projects/${p.id}/file?path=${encodeURIComponent('КП v1.docx')}`, { cookie: olga });
    const inTrash = await status('КП v1.docx');
    expect(inTrash).toMatchObject({ state: 'trash', name: 'КП v1.docx', projectId: p.id });
    const download = await t.call('GET', `/app/api/threads/${threadId}/file?path=${encodeURIComponent('КП v1.docx')}`, { cookie: olga });
    expect(download.status).toBe(404);
    expect((await json<{ error: { code: string; message: string } }>(download)).error).toMatchObject({ code: 'APP_FILE_IN_TRASH', message: expect.stringMatching(/^Файл «КП v1\.docx» удалён из рабочей папки\. Он в корзине проекта до \d+ [а-я]+\.$/) });
    const fromTrash = await t.call('GET', `/app/api/projects/${p.id}/trash/${inTrash.state === 'trash' ? inTrash.trashId : ''}/file`, { cookie: olga });
    expect(await fromTrash.text()).toBe('КП');
    expect(fromTrash.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('КП v1.docx')}`);
    expect(await status('нет такого.docx')).toEqual({ state: 'deleted', name: 'нет такого.docx' });
    const gone = await t.call('GET', `/app/api/threads/${threadId}/file?path=${encodeURIComponent('нет такого.docx')}`, { cookie: olga });
    expect((await json<{ error: { code: string; message: string } }>(gone)).error).toEqual({ code: 'APP_FILE_DELETED', message: 'Файл «нет такого.docx» удалён из рабочей папки — скачать его нельзя.' });
  });

  it('an archived project’s trash is only read', async () => {
    const p = await project('Архивная корзина');
    put(p.files, 'файл.txt', 'Ф');
    await t.call('DELETE', `/app/api/projects/${p.id}/file?path=${encodeURIComponent('файл.txt')}`, { cookie: olga });
    await t.db.query('UPDATE app.projects SET archived_at = now() WHERE id = $1', [p.id]);
    const [batch] = await trashOf(p.id);
    const res = await restore(p.id, { batchId: batch!.id });
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('APP_PROJECT_ARCHIVED');
    const form = new FormData();
    form.append('file', new File([new Uint8Array([1])], 'новый.txt'));
    expect((await t.app.request(`/app/api/projects/${p.id}/files`, { method: 'POST', body: form, headers: { cookie: olga, origin: TEST_PUBLIC_URL } })).status).toBe(409);
  });

  // Whatever the answer does between the snapshot and its end — removes, renames, writes anew — the
  // trash gets exactly the files of the snapshot that are nowhere in the folder any more.
  it('takes exactly the files the answer left nowhere in the folder', async () => {
    const NAMES = ['а.txt', 'б.txt', 'в/г.txt', 'в/д.txt', 'е.txt'];
    const step = fc.oneof(
      fc.record({ op: fc.constant('remove' as const), name: fc.constantFrom(...NAMES) }),
      fc.record({ op: fc.constant('rename' as const), name: fc.constantFrom(...NAMES), to: fc.constantFrom('ж.txt', 'в/з.txt') }),
      fc.record({ op: fc.constant('create' as const), name: fc.constantFrom(...NAMES, 'и.txt') }),
    );
    const p = await project('Свойство');
    await fc.assert(
      fc.asyncProperty(fc.subarray(NAMES, { minLength: 1 }), fc.array(step, { maxLength: 8 }), async (present, steps) => {
        rmSync(p.files, { recursive: true, force: true });
        await t.db.query('DELETE FROM app.project_trash WHERE project_id = $1', [p.id]);
        for (const name of present) put(p.files, name, `исходный ${name}`);
        const snapshot = snapshotOf(p.id);
        // The model: which original file each path holds now. Writing an existing path keeps its file
        // on the disk (written in place), a rename carries the file over whatever was there.
        const holds = new Map<string, string>(present.map((name) => [name, name]));
        for (const s of steps) {
          const from = join(p.files, s.name);
          if (s.op === 'remove') {
            rmSync(from, { force: true });
            holds.delete(s.name);
          }
          if (s.op === 'create') {
            if (!holds.has(s.name)) holds.set(s.name, `new:${s.name}`);
            put(p.files, s.name, `новый ${s.name}`);
          }
          if (s.op === 'rename' && holds.has(s.name)) {
            mkdirSync(dirname(join(p.files, s.to)), { recursive: true });
            renameSync(from, join(p.files, s.to));
            holds.set(s.to, holds.get(s.name)!);
            if (s.to !== s.name) holds.delete(s.name);
          }
        }
        await settleSnapshot(t.db, t.workspaceRoot, snapshot);
        const trashed = (await trashOf(p.id)).flatMap((b) => b.items).filter((i) => i.kind === 'deleted').map((i) => i.path).sort();
        const kept = new Set(holds.values());
        // Removed: an original that no path holds, and whose own path is empty (a new file there makes
        // the original a previous version instead).
        const expected = present.filter((name) => !kept.has(name) && !holds.has(name)).sort();
        expect(trashed).toEqual(expected);
      }),
      { numRuns: 60 },
    );
  });
});

// The agent may swap a folder for a link to someone else's files or put a pipe in place of a file
// (independent review 16.11): the trash never follows it, never hangs on it.
describe('the trash against the agent’s tricks', () => {
  it('brings a file back to the top of the project when its folder became a link elsewhere', async () => {
    const p = await project('Ярлык при возврате');
    put(p.files, 'sub/x.docx', 'X');
    await t.call('DELETE', `/app/api/projects/${p.id}/file?path=${encodeURIComponent('sub/x.docx')}`, { cookie: olga });
    const elsewhere = mkdtempSync(join(tmpdir(), 'bba-elsewhere-'));
    rmSync(join(p.files, 'sub'), { recursive: true });
    symlinkSync(elsewhere, join(p.files, 'sub'));
    const [batch] = await trashOf(p.id);
    expect((await json<{ restored: string[] }>(await restore(p.id, { batchId: batch!.id }))).restored).toEqual(['x.docx']);
    expect(readFileSync(join(p.files, 'x.docx'), 'utf8')).toBe('X');
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('does not take files of a folder that is a link elsewhere, nor hang on a pipe', async () => {
    const p = await project('Ярлык и канал');
    const elsewhere = mkdtempSync(join(tmpdir(), 'bba-elsewhere-'));
    writeFileSync(join(elsewhere, 'чужое.txt'), 'ЧУЖОЕ');
    symlinkSync(elsewhere, join(p.files, 'чужая'));
    put(p.files, 'свой.txt', 'С');
    const snapshot = snapshotOf(p.id);
    rmSync(join(p.files, 'чужая'));
    // A pipe in place of the file: reading it would wait forever.
    rmSync(join(p.files, 'свой.txt'));
    execFileSync('mkfifo', [join(p.files, 'свой.txt')]);
    await settleSnapshot(t.db, t.workspaceRoot, snapshot);
    const items = (await trashOf(p.id)).flatMap((b) => b.items);
    expect(items.map((i) => i.path)).toEqual(['свой.txt']);
    expect(readFileSync(join(trashDir(t.workspaceRoot, olgaId, p.id), items[0]!.id), 'utf8')).toBe('С');
    expect(readFileSync(join(elsewhere, 'чужое.txt'), 'utf8')).toBe('ЧУЖОЕ');
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('two answers at once: a previous version is kept once, and the rows say the answers overlapped', async () => {
    const p = await project('Одновременно');
    put(p.files, 'смета.xlsx', 'старая');
    const first = snapshotOf(p.id);
    const second = snapshotOf(p.id);
    writeFileSync(join(p.files, 'смета.new'), 'новая');
    renameSync(join(p.files, 'смета.new'), join(p.files, 'смета.xlsx'));
    await settleSnapshot(t.db, t.workspaceRoot, first);
    await settleSnapshot(t.db, t.workspaceRoot, second);
    const batches = await trashOf(p.id);
    expect(batches.flatMap((b) => b.items).map((i) => [i.path, i.kind])).toEqual([['смета.xlsx', 'previous_version']]);
    expect(batches[0]!.overlapped).toBe(true);
    // One answer alone: not overlapped.
    put(p.files, 'один.txt', 'О');
    const alone = snapshotOf(p.id);
    rmSync(join(p.files, 'один.txt'));
    await settleSnapshot(t.db, t.workspaceRoot, alone);
    expect((await trashOf(p.id)).find((b) => b.id === alone.id)?.overlapped).toBe(false);
  });

  it('at the start gives a folder left with another person back to the creator, and reads a broken note', async () => {
    const p = await project('Сбой передачи');
    put(p.files, 'договор.pdf', 'Д');
    // A removal of an employee stopped between moving the folder and writing it down.
    const stray = join(t.workspaceRoot, petrId, 'projects', p.id);
    mkdirSync(dirname(stray), { recursive: true });
    renameSync(join(t.workspaceRoot, olgaId, 'projects', p.id), stray);
    await recoverProjectFolders(t.db, t.workspaceRoot);
    expect(readFileSync(join(p.files, 'договор.pdf'), 'utf8')).toBe('Д');
    expect(existsSync(stray)).toBe(false);
    // A snapshot whose note was written halfway: its removals still reach the trash.
    const snapshot = snapshotOf(p.id);
    writeFileSync(join(t.workspaceRoot, olgaId, 'projects', p.id, '.snapshots', `${snapshot.id}.json`), '{"userId":');
    rmSync(join(p.files, 'договор.pdf'));
    await recoverProjectFolders(t.db, t.workspaceRoot);
    expect((await trashOf(p.id)).flatMap((b) => b.items).map((i) => i.path)).toEqual(['договор.pdf']);
  });
});
