// «Бланк, печать и подпись» on the server (docs/specs/[20.11.2026]-org-letterhead.md, step 1): the letterhead goes
// through blank.py and LibreOffice in the real sandbox, pictures are checked by their bytes, the stamp, the signature
// and the responsible people are a superadmin's alone, and every change is in the audit.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrgAssetsState } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgFilePaths } from './files.ts';
import { testPng } from './test-pictures.ts';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const PREVIEW_FIXTURES = new URL('../preview/fixtures/', import.meta.url);

let t: TestApp;
let admin: string;
let adminId: string;
let olgaId: string;
let profiler: string;

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function upload(cookie: string, kind: string, name: string, bytes: Uint8Array) {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], name));
  return Promise.resolve(t.app.request(`/app/api/admin/org-assets/${kind}`, { method: 'PUT', body: form, headers: { cookie, origin: TEST_PUBLIC_URL } }));
}

const fixture = (name: string, from = FIXTURES) => readFileSync(new URL(name, from));

beforeAll(async () => {
  t = await createTestApp({ sandbox: true });
  adminId = await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  admin = await t.signIn('igor@example.com');
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга Смирнова' });
  const role = await json<{ id: string }>(await t.call('POST', '/app/api/admin/roles', { cookie: admin, body: { name: 'Профиль', permissions: ['org_profile'] } }));
  await t.createUser({ email: 'anna@example.com', name: 'Анна', roleIds: [role.id] });
  profiler = await t.signIn('anna@example.com');
}, 60_000);
afterAll(async () => {
  await t.close();
});

describe('the letterhead', () => {
  it('keeps a letterhead drawn in the body above [[ТЕКСТ]], shows its start as a PDF and lays out the copy without text', async () => {
    const res = await upload(profiler, 'blank', 'Бланк Альфа-Строй.docx', fixture('body-table-mark.docx'));
    expect(res.status).toBe(200);
    const state = await json<OrgAssetsState>(res);
    expect(state.blank).toMatchObject({ fileName: 'Бланк Альфа-Строй.docx', info: { mark: true, header: false, bodyDrawing: false } });
    const preview = await t.call('GET', '/app/api/admin/org-assets/blank/preview', { cookie: profiler });
    expect(preview.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await preview.arrayBuffer()).subarray(0, 4).toString('latin1')).toBe('%PDF');
    const { blank } = await orgFilePaths(t.db, t.orgFilesDir);
    expect(blank && existsSync(blank)).toBe(true);
    // The copy has the table of the letterhead and none of the letter below the line.
    const copy = readFileSync(blank!);
    expect(copy.subarray(0, 2).toString('latin1')).toBe('PK');
    const download = await t.call('GET', '/app/api/admin/org-assets/blank/file', { cookie: profiler });
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(Buffer.from(await download.arrayBuffer()).equals(fixture('body-table-mark.docx'))).toBe(true);
    const { rows } = await t.db.query<{ details: { mark: boolean } }>("SELECT details FROM app.admin_audit WHERE action = 'org_assets.upload' AND target = 'blank'");
    expect(rows[0]?.details.mark).toBe(true);
  }, 60_000);

  it('says the letterhead was drawn in the body when nothing is left of it', async () => {
    const state = await json<OrgAssetsState>(await upload(admin, 'blank', 'Бланк.docx', fixture('body-table.docx')));
    expect(state.blank?.info).toEqual({ mark: false, header: false, bodyDrawing: true });
  }, 60_000);

  it('refuses an old .doc, a letterhead with a password and a broken one, each with its code', async () => {
    const doc = await upload(admin, 'blank', 'Бланк.doc', fixture('kp.doc', PREVIEW_FIXTURES));
    expect(doc.status).toBe(400);
    expect(await json(doc)).toMatchObject({ error: { code: 'APP_ORG_BLANK_FORMAT' } });
    const secret = await upload(admin, 'blank', 'Бланк.docx', fixture('secret.docx', PREVIEW_FIXTURES));
    expect(await json(secret)).toMatchObject({ error: { code: 'APP_ORG_BLANK_BROKEN' } });
    const broken = await upload(admin, 'blank', 'Бланк.docx', fixture('broken.docx', PREVIEW_FIXTURES));
    expect(await json(broken)).toMatchObject({ error: { code: 'APP_ORG_BLANK_BROKEN' } });
  }, 60_000);
});

describe('pictures', () => {
  it('takes the logo from whoever has the right, but the stamp and the signature only from a superadmin', async () => {
    expect((await upload(profiler, 'logo', 'logo.png', testPng(300, 100, { alpha: true }))).status).toBe(200);
    const stamp = await upload(profiler, 'stamp', 'stamp.png', testPng(400, 400, { alpha: true }));
    expect(stamp.status).toBe(403);
    expect(await json(stamp)).toMatchObject({ error: { code: 'APP_ADMIN_FORBIDDEN' } });
    expect((await t.call('PUT', '/app/api/admin/org-signers', { cookie: profiler, body: { userIds: [olgaId] } })).status).toBe(403);
    expect((await upload(admin, 'stamp', 'stamp.png', testPng(400, 400, { alpha: true }))).status).toBe(200);
    expect((await t.call('GET', '/app/api/admin/org-assets/stamp/file', { cookie: profiler })).status).toBe(403);
    expect((await t.call('DELETE', '/app/api/admin/org-assets/stamp', { cookie: profiler })).status).toBe(403);
    // Whoever is not a superadmin does not even learn whether the stamp is there.
    expect((await json<OrgAssetsState>(await t.call('GET', '/app/api/admin/org-assets', { cookie: profiler }))).seal).toBeNull();
    const seal = (await json<OrgAssetsState>(await t.call('GET', '/app/api/admin/org-assets', { cookie: admin }))).seal;
    expect(seal?.stamp).toMatchObject({ width: 400, height: 400 });
  });

  it('refuses a stamp without transparency, a picture that is not PNG and one too big', async () => {
    const opaque = await upload(admin, 'stamp', 'stamp.png', testPng(400, 400, { alpha: false }));
    expect(await json(opaque)).toMatchObject({ error: { code: 'APP_ORG_IMAGE_FORMAT', message: expect.stringContaining('прозрачный фон') } });
    expect(await json(await upload(admin, 'signature', 'sign.jpg', fixture('kp.doc', PREVIEW_FIXTURES)))).toMatchObject({ error: { code: 'APP_ORG_IMAGE_FORMAT' } });
    expect(await json(await upload(admin, 'signature', 'sign.png', testPng(900, 200, { alpha: true })))).toMatchObject({ error: { code: 'APP_ORG_IMAGE_FORMAT' } });
  });

  it('lays out the letterhead and the logo for agents, never the stamp or the signature', async () => {
    expect((await upload(admin, 'signature', 'sign.png', testPng(500, 150, { alpha: true }))).status).toBe(200);
    await orgFilePaths(t.db, t.orgFilesDir);
    const laid = readdirSync(t.orgFilesDir, { recursive: true }).map(String);
    // A replaced letterhead keeps its folder until the next start: only the names matter here.
    expect([...new Set(laid.filter((p) => p.includes('/')).map((p) => p.split('/').at(-1)))].sort()).toEqual(['blank.docx', 'logo.png']);
    const { rows } = await t.db.query<{ sha256: string }>("SELECT sha256 FROM app.org_assets WHERE kind IN ('stamp', 'signature')");
    for (const r of rows) expect(existsSync(join(t.orgFilesDir, r.sha256))).toBe(false);
  });
});

describe('the director and the responsible people', () => {
  it('wants a full name, keeps who the signature was uploaded for and writes the audit', async () => {
    const short = await t.call('PUT', '/app/api/admin/org-director', { cookie: profiler, body: { position: 'Генеральный директор', fullName: 'Иванов', signatureName: 'Иванов' } });
    expect(short.status).toBe(400);
    expect(await json(short)).toMatchObject({ error: { message: 'Укажите ФИО полностью: фамилия, имя, отчество (если есть).' } });
    // Brackets of a mark in the name would be found again by the signing in the line it writes.
    const bracket = await t.call('PUT', '/app/api/admin/org-director', { cookie: profiler, body: { position: '[[ПОДПИСЬ_РУКОВОДИТЕЛЯ]]', fullName: 'Иванов Иван', signatureName: 'И. Иванов' } });
    expect(bracket.status).toBe(400);
    const director = { position: 'Генеральный директор', fullName: 'Иванов Иван Петрович', signatureName: 'И. П. Иванов' };
    expect((await t.call('PUT', '/app/api/admin/org-director', { cookie: profiler, body: director })).status).toBe(200);
    expect((await upload(admin, 'signature', 'sign.png', testPng(500, 150, { alpha: true }))).status).toBe(200);
    await t.call('PUT', '/app/api/admin/org-director', { cookie: admin, body: { ...director, fullName: 'Петров Пётр Петрович', signatureName: 'П. П. Петров' } });
    const state = await json<OrgAssetsState>(await t.call('GET', '/app/api/admin/org-assets', { cookie: admin }));
    expect(state.director.fullName).toBe('Петров Пётр Петрович');
    // The signature is still Ivanov's: the block asks for a new one.
    expect(state.seal?.signature?.director).toBe('Иванов Иван Петрович');
  });

  it('lets only a superadmin name the responsible people, nobody by default, and writes who was added and removed', async () => {
    expect((await json<OrgAssetsState>(await t.call('GET', '/app/api/admin/org-assets', { cookie: admin }))).seal?.signers).toEqual([]);
    const set = await json<OrgAssetsState>(await t.call('PUT', '/app/api/admin/org-signers', { cookie: admin, body: { userIds: [olgaId, adminId] } }));
    expect(set.seal?.signers.map((s) => s.name)).toEqual(['Игорь', 'Ольга Смирнова']);
    await t.call('PUT', '/app/api/admin/org-signers', { cookie: admin, body: { userIds: [adminId] } });
    const { rows } = await t.db.query<{ details: { added: string[]; removed: string[] } }>("SELECT details FROM app.admin_audit WHERE action = 'org_signers.update' ORDER BY at");
    expect(rows.map((r) => r.details)).toEqual([
      { added: [olgaId, adminId], removed: [] },
      { added: [], removed: [olgaId] },
    ]);
    expect((await t.call('PUT', '/app/api/admin/org-signers', { cookie: admin, body: { userIds: ['nobody'] } })).status).toBe(400);
  });
});
