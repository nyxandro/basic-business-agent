// «Скиллы» end to end (spec, scenario 10): upload, who gets a skill, switching off, a new version,
// removal — through the admin routes, the database and the folder of unpacked copies.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SkillDto, SkillPreview, SkillsResponse } from '@bba/contracts';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';
import { createSkillsRuntime, type SkillsRuntime } from './runtime.ts';

const PACKED = readFileSync(fileURLToPath(new URL('../../skills/read-documents.skill', import.meta.url)));
const NAME = 'read-documents';

let t: TestApp;
let runtime: SkillsRuntime;
let igor: string;
let olgaId: string;
let petrId: string;
let sales: string;

function form(archive: Uint8Array, access?: unknown): FormData {
  const f = new FormData();
  f.append('file', new File([archive], 'skill.skill'));
  if (access) f.append('access', JSON.stringify(access));
  return f;
}
const send = (method: string, path: string, body: FormData, cookie = igor) => t.app.request(path, { method, body, headers: { cookie, origin: TEST_PUBLIC_URL } });
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const toSales = { scope: 'departments', departmentIds: [] as string[], userIds: [] as string[] };
const version = (body: string) => zipSync({ [`${NAME}/SKILL.md`]: new TextEncoder().encode(`---\nname: ${NAME}\ndescription: Читает документы\n---\n\n# Чтение документов\n\n${body}\n`) });
const copies = () => (existsSync(join(t.skillsDir, NAME)) ? readdirSync(join(t.skillsDir, NAME)) : []);

beforeAll(async () => {
  t = await createTestApp();
  runtime = createSkillsRuntime({ db: t.db, skillsDir: t.skillsDir });
  sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Отдел продаж') RETURNING id`)).rows[0]!.id;
  toSales.departmentIds = [sales];
  await t.createUser({ email: 'igor@example.com', roleIds: [await t.roleId('superadmin')] });
  olgaId = await t.createUser({ email: 'olga@example.com', departmentIds: [sales] });
  petrId = await t.createUser({ email: 'petr@example.com' });
  igor = await t.signIn('igor@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('skills of the installation', () => {
  it('shows what is in the file before saving, with the libraries the scripts may use', async () => {
    const res = await send('POST', '/app/api/admin/skills?check=1', form(PACKED));
    const preview = await json<SkillPreview>(res);
    expect(preview).toMatchObject({ name: NAME, title: 'Чтение документов', hasScripts: true, exists: false, sizeBytes: PACKED.length });
    expect(preview.files.map((f) => f.path)).toContain('scripts/read_pdf.py');
    expect((await json<SkillsResponse>(await t.call('GET', '/app/api/admin/skills', { cookie: igor }))).libraries).toEqual(expect.arrayContaining(['pypdf', 'openpyxl']));
    expect(copies()).toEqual([]);
  });

  it('gives the skill only to the people of its scope: Olga of the sales department, not Petr', async () => {
    const res = await send('POST', '/app/api/admin/skills', form(PACKED, toSales));
    expect(res.status).toBe(201);
    expect(await json<SkillDto>(res)).toMatchObject({ name: NAME, enabled: true, access: { scope: 'departments', departmentIds: [sales], userIds: [] } });
    const [olgaSkill] = await runtime.skillsFor(olgaId);
    expect(readFileSync(join(olgaSkill!, 'SKILL.md'), 'utf8')).toContain('# Чтение документов');
    expect(await runtime.skillsFor(petrId)).toEqual([]);

    const personal = await t.call('PUT', `/app/api/admin/skills/${NAME}`, { cookie: igor, body: { access: { scope: 'users', departmentIds: [], userIds: [petrId] } } });
    expect(personal.status).toBe(200);
    expect(await runtime.skillsFor(olgaId)).toEqual([]);
    expect(await runtime.skillsFor(petrId)).toHaveLength(1);
    await t.call('PUT', `/app/api/admin/skills/${NAME}`, { cookie: igor, body: { access: toSales } });
  });

  it('refuses the same name twice, a broken file and an empty scope', async () => {
    expect(await json<{ error: { code: string } }>(await send('POST', '/app/api/admin/skills', form(PACKED, toSales)))).toMatchObject({ error: { code: 'APP_SKILL_EXISTS' } });
    expect((await json<{ error: { code: string } }>(await send('POST', '/app/api/admin/skills', form(new TextEncoder().encode('not a zip'), toSales)))).error.code).toBe('APP_SKILL_INVALID');
    const other = zipSync({ 'notes/SKILL.md': new TextEncoder().encode('---\nname: notes\ndescription: Заметки\n---\n# Заметки\n') });
    expect((await json<{ error: { code: string } }>(await send('POST', '/app/api/admin/skills', form(other, { scope: 'departments', departmentIds: [], userIds: [] })))).error.code).toBe('APP_VALIDATION_FAILED');
  });

  it('hides a switched off skill from everyone', async () => {
    await t.call('PUT', `/app/api/admin/skills/${NAME}`, { cookie: igor, body: { enabled: false } });
    expect(await runtime.skillsFor(olgaId)).toEqual([]);
    await t.call('PUT', `/app/api/admin/skills/${NAME}`, { cookie: igor, body: { enabled: true } });
    expect(await runtime.skillsFor(olgaId)).toHaveLength(1);
  });

  it('replaces the version without taking the old copy from an answer that is running', async () => {
    const [before] = await runtime.skillsFor(olgaId);
    const res = await send('PUT', `/app/api/admin/skills/${NAME}`, form(version('Новая версия.')));
    expect(res.status).toBe(200);
    const [after] = await runtime.skillsFor(olgaId);
    expect(after).not.toBe(before);
    expect(readFileSync(join(after!, 'SKILL.md'), 'utf8')).toContain('Новая версия.');
    expect(existsSync(before!)).toBe(true);
    // A file of another skill is not a new version of this one.
    const other = zipSync({ 'notes/SKILL.md': new TextEncoder().encode('---\nname: notes\ndescription: Заметки\n---\n# Заметки\n') });
    expect((await json<{ error: { code: string } }>(await send('PUT', `/app/api/admin/skills/${NAME}`, form(other)))).error.code).toBe('APP_SKILL_INVALID');

    // At the next start only the current copy stays, and a lost copy is unpacked again.
    await runtime.prepare();
    expect(copies()).toEqual([after!.split('/').at(-1)]);
  });

  it('is open only to roles with the right «Скиллы»', async () => {
    const olga = await t.signIn('olga@example.com');
    expect((await t.call('GET', '/app/api/admin/skills', { cookie: olga })).status).toBe(403);
    expect((await send('POST', '/app/api/admin/skills?check=1', form(PACKED), olga)).status).toBe(403);
  });

  it('removes the skill with its copy', async () => {
    expect((await t.call('DELETE', `/app/api/admin/skills/${NAME}`, { cookie: igor })).status).toBe(200);
    expect(copies()).toEqual([]);
    expect(await runtime.skillsFor(olgaId)).toEqual([]);
    expect((await json<SkillsResponse>(await t.call('GET', '/app/api/admin/skills', { cookie: igor }))).skills).toEqual([]);
  });
});
