// What the agent is told of the letterhead, the director and the stamp (docs/specs/[20.11.2026]-org-letterhead.md, step 3),
// and what its sandbox sees: the letterhead and the logo read-only, never the stamp or the signature.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestContext } from '@mastra/core/request-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REQUEST_KEYS } from '../run-context/request-keys.ts';
import { createLimiter } from '../sandbox/limiter.ts';
import { assertIsolationAvailable, createAgentWorkspace } from '../sandbox/workspace.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { notASigner, orgDocsText, SIGN_MARK } from './prompt.ts';
import { testPng } from './test-pictures.ts';

const VENV = fileURLToPath(new URL('../../.venv-skills', import.meta.url));

let t: TestApp;
let olga: string;
let olgaId: string;

const systemOf = () => t.model.requests.at(-1)!.messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n\n');

async function chat(text: string): Promise<void> {
  const body = { threadId: randomUUID(), runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: text }], tools: [], context: [], state: {}, forwardedProps: {} };
  const res = await t.app.request('/app/api/copilotkit/agent/sales/run', { method: 'POST', headers: { cookie: olga, origin: 'http://localhost:8080', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  await res.text();
}

async function putAsset(kind: 'blank' | 'logo' | 'stamp' | 'signature', bytes: Buffer, sha: string): Promise<void> {
  if (kind === 'blank') {
    await t.db.query(
      `INSERT INTO app.org_assets (kind, content, sha256, file_name, prepared, preview, blank_info) VALUES ('blank', $1, $2, 'Бланк.docx', $1, '%PDF', '{"mark":false,"header":true,"bodyDrawing":false}')`,
      [bytes, sha],
    );
    return;
  }
  await t.db.query('INSERT INTO app.org_assets (kind, content, sha256, width, height) VALUES ($1, $2, $3, 10, 10)', [kind, bytes, sha]);
}

beforeAll(async () => {
  t = await createTestApp();
  olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  const dep = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [dep, olgaId]);
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [dep]);
  olga = await t.signIn('olga@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('the prompt', () => {
  it('tells an employee who is not responsible only that the stamp is not theirs to put', async () => {
    t.model.script({ text: 'Готово.' });
    await chat('Сделай КП');
    expect(systemOf()).toContain(notASigner(true));
    expect(systemOf()).not.toContain('[[ПОДПИСЬ_РУКОВОДИТЕЛЯ]]');
    expect(systemOf()).not.toContain('Бланк организации');
  });

  it('names the director above the requisites, the letterhead and the logo by their paths', async () => {
    await t.db.query(`UPDATE app.org_profile SET requisites = 'Директор Сидоров С. С.', director_position = 'Генеральный директор', director_full_name = 'Иванов Иван Петрович', director_signature_name = 'И. П. Иванов'`);
    await putAsset('blank', Buffer.from('PK blank'), 'a'.repeat(64));
    await putAsset('logo', testPng(30, 10, { alpha: true }), 'b'.repeat(64));
    t.model.script({ text: 'Готово.' });
    await chat('Сделай КП');
    const system = systemOf();
    expect(system).toContain('Руководитель (главнее реквизитов): Генеральный директор — Иванов Иван Петрович; в строке подписи — «И. П. Иванов»');
    expect(system).toContain(`Бланк организации: ${join(t.orgFilesDir, 'a'.repeat(64), 'blank.docx')}`);
    expect(system).toContain(`Логотип: ${join(t.orgFilesDir, 'b'.repeat(64), 'logo.png')}`);
  });

  it('gives a responsible person the rule of the mark, or says what is missing to put the stamp', async () => {
    await t.db.query('INSERT INTO app.org_signers (user_id) VALUES ($1)', [olgaId]);
    t.model.script({ text: 'Готово.' });
    await chat('Сделай КП с подписью');
    expect(systemOf()).toContain('печати организации и подписи руководителя в профиле нет');
    expect(systemOf()).not.toContain(notASigner(true));
    await putAsset('stamp', testPng(10, 10, { alpha: true }), 'c'.repeat(64));
    await putAsset('signature', testPng(10, 10, { alpha: true }), 'd'.repeat(64));
    t.model.script({ text: 'Готово.' });
    await chat('Сделай КП с подписью');
    expect(systemOf()).toContain('[[ПОДПИСЬ_РУКОВОДИТЕЛЯ]]');
    expect(systemOf()).toContain('org_sign_document');
  });

  it('tells an agent without commands only who the director is', async () => {
    const admin = await t.createUser({ email: 'igor@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
    const cookie = await t.signIn('igor@example.com');
    expect(admin).toBeTruthy();
    await t.call('PUT', '/app/api/admin/agents/sales/abilities', { cookie, body: { commands: false } });
    t.model.script({ text: 'Готово.' });
    await chat('Сделай КП с подписью');
    expect(systemOf()).toContain('Руководитель (главнее реквизитов)');
    expect(systemOf()).not.toContain('Бланк организации');
    expect(systemOf()).not.toContain('[[ПОДПИСЬ_РУКОВОДИТЕЛЯ]]');
    await t.call('PUT', '/app/api/admin/agents/sales/abilities', { cookie, body: { commands: true } });
  });
});

describe('the text of the prompt', () => {
  // A sub-agent answers the agent that called it and never puts the stamp: it hears nothing of the stamp, so it does not
  // tell a responsible person's agent «это делают ответственные лица».
  it('tells a sub-agent of the letterhead and the director, nothing of the stamp', () => {
    const facts = { director: { position: 'Генеральный директор', fullName: 'Иванов Иван Петрович', signatureName: 'И. П. Иванов' }, paths: { blank: '/b/blank.docx', logo: null }, commands: true };
    const sub = orgDocsText({ ...facts, sealGaps: [], level: 'sub', withStamp: true })!;
    expect(sub).toContain('Бланк организации: /b/blank.docx');
    expect(sub).not.toContain(notASigner(true));
    expect(sub).not.toContain(SIGN_MARK);
    expect(orgDocsText({ ...facts, sealGaps: [], level: 'top', withStamp: true })).toContain(SIGN_MARK);
    expect(orgDocsText({ ...facts, sealGaps: null, level: 'top', withStamp: true })).toContain(notASigner(true));
  });

  // An organisation without a stamp (decision of the owner 21.11): the agent puts and speaks of the signature alone.
  it('speaks of the signature alone in an organisation without a stamp', () => {
    const facts = { director: { position: 'Генеральный директор', fullName: 'Иванов Иван Петрович', signatureName: 'И. П. Иванов' }, paths: { blank: null, logo: null }, commands: true, level: 'top' as const };
    const signer = orgDocsText({ ...facts, sealGaps: [], withStamp: false })!;
    expect(signer).toContain('Подпись руководителя ставишь');
    expect(signer).toContain('печати у организации нет');
    expect(orgDocsText({ ...facts, sealGaps: null, withStamp: false })).toContain(notASigner(false));
    expect(notASigner(false)).not.toContain('Печать');
  });
});

describe('the sandbox of an answer', () => {
  it('reads the letterhead laid out for agents and nothing outside its folders', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bba-org-sandbox-'));
    try {
      const orgFilesDir = join(root, 'org');
      mkdirSync(join(orgFilesDir, 'e'.repeat(64)), { recursive: true });
      writeFileSync(join(orgFilesDir, 'e'.repeat(64), 'blank.docx'), 'PK letterhead');
      // Where a stamp would be if it ever were on the disk of the server: outside every folder of the sandbox.
      writeFileSync(join(root, 'stamp.png'), 'stamp');
      const workspace = createAgentWorkspace({ workspaceRoot: join(root, 'ws'), skillsVenv: VENV, limiter: createLimiter(8, 60_000), orgFilesDir, beforeWrite: () => undefined }, assertIsolationAvailable());
      const rc = new RequestContext();
      for (const [key, value] of [[REQUEST_KEYS.userId, 'olga'], [REQUEST_KEYS.threadId, 't-org'], [REQUEST_KEYS.skillPaths, '[]']] as const) rc.set(key, value);
      const sandbox = (await workspace.resolveSandbox({ requestContext: rc }))!;
      const read = await sandbox.executeCommand!('cat', [join(orgFilesDir, 'e'.repeat(64), 'blank.docx')]);
      expect(read.stdout).toBe('PK letterhead');
      const written = await sandbox.executeCommand!('sh', ['-c', `echo x > ${join(orgFilesDir, 'x')}`]);
      expect(written.exitCode).not.toBe(0);
      const stamp = await sandbox.executeCommand!('cat', [join(root, 'stamp.png')]);
      expect(stamp.exitCode).not.toBe(0);
      await sandbox.destroy?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
