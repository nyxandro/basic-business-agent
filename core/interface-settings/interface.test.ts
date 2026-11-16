// The look of the chat end to end (spec, section 8.17; decision of the owner 16.11): «Интерфейс» says
// whether the chat shows the marks of the agents; every agent has its own mark — an icon or the
// admin's picture — set by whoever may set agents up and shown with the list of agents.
import type { AdminAgentsResponse, AgentListResponse, AgentMark, AgentMarkAdminState, InterfaceAdminState, MeResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';
import { JPEG_2X2 as JPEG, PNG_2X2 as PNG, pngHeader, WEBP_2X2 as WEBP } from './test-pictures.ts';

let t: TestApp;
let igor: string;
let olga: string;
let petr: string;
let anna: string;

type Form = { kind?: string; icon?: string; image?: { bytes: Uint8Array; name: string; type: string } };
function form({ kind, icon, image }: Form): FormData {
  const f = new FormData();
  if (kind !== undefined) f.append('kind', kind);
  if (icon !== undefined) f.append('icon', icon);
  if (image) f.append('image', new File([image.bytes], image.name, { type: image.type }));
  return f;
}
const saveMark = (agentId: string, body: Form, cookie = igor) =>
  t.app.request(`/app/api/admin/agents/${agentId}/mark`, { method: 'PUT', body: form(body), headers: { cookie, origin: TEST_PUBLIC_URL } });
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const errorCode = async (res: Response) => (await json<{ error: { code: string } }>(res)).error.code;
// What the chat of a person draws for an agent.
const markOf = async (agentId: string, cookie = olga): Promise<AgentMark | undefined> =>
  (await json<AgentListResponse>(await t.call('GET', '/app/api/agents', { cookie }))).agents.find((a) => a.id === agentId)?.mark;
const adminMark = async (agentId: string): Promise<AgentMarkAdminState | undefined> =>
  (await json<AdminAgentsResponse>(await t.call('GET', '/app/api/admin/agents', { cookie: igor }))).agents.find((a) => a.id === agentId)?.mark;
const urlOf = (mark: AgentMark | undefined) => (mark as { url: string }).url;
const png = { bytes: PNG, name: 'logo.png', type: 'image/png' };

beforeAll(async () => {
  t = await createTestApp();
  const sales = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [sales]);
  await t.createUser({ email: 'igor@example.com', roleIds: [await t.roleId('superadmin')] });
  await t.createUser({ email: 'olga@example.com', departmentIds: [sales] });
  const designer = (await t.db.query<{ id: string }>(`INSERT INTO app.roles (name, permissions) VALUES ('Оформление', '["interface"]') RETURNING id`)).rows[0]!.id;
  await t.createUser({ email: 'petr@example.com', roleIds: [designer] });
  const agentsAdmin = (await t.db.query<{ id: string }>(`INSERT INTO app.roles (name, permissions) VALUES ('Агенты', '["agents"]') RETURNING id`)).rows[0]!.id;
  await t.createUser({ email: 'anna@example.com', roleIds: [agentsAdmin] });
  igor = await t.signIn('igor@example.com');
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
  anna = await t.signIn('anna@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('«Показывать значок агента в чате»', () => {
  const showOf = async (cookie: string) => (await json<MeResponse>(await t.call('GET', '/app/api/me', { cookie }))).interface.showAgentMark;

  it('is on in a new installation and changed only with the right «Интерфейс», with a record in the audit', async () => {
    expect(await showOf(olga)).toBe(true);
    expect(await json<InterfaceAdminState>(await t.call('GET', '/app/api/admin/interface', { cookie: petr }))).toEqual({ showAgentMark: true });
    expect((await t.call('GET', '/app/api/admin/interface', { cookie: olga })).status).toBe(403);
    const refused = await t.call('PUT', '/app/api/admin/interface', { cookie: anna, body: { showAgentMark: false } });
    expect(await errorCode(refused)).toBe('APP_ADMIN_FORBIDDEN');

    const off = await t.call('PUT', '/app/api/admin/interface', { cookie: petr, body: { showAgentMark: false } });
    expect(await json<InterfaceAdminState>(off)).toEqual({ showAgentMark: false });
    expect(await showOf(olga)).toBe(false);
    // The marks stay with the agents: turning the switch on brings them back as they were.
    expect(await markOf('sales')).toEqual({ kind: 'icon', icon: 'spark' });
    await t.call('PUT', '/app/api/admin/interface', { cookie: petr, body: { showAgentMark: true } });
    expect(await showOf(olga)).toBe(true);
    const { rows } = await t.db.query<{ details: { showAgentMark: boolean } }>(`SELECT details FROM app.admin_audit WHERE action = 'interface.update' ORDER BY id`);
    expect(rows.map((r) => r.details.showAgentMark)).toEqual([false, true]);
  });

  it('refuses anything but on or off', async () => {
    for (const body of [{}, { showAgentMark: 'yes' }]) expect(await errorCode(await t.call('PUT', '/app/api/admin/interface', { cookie: igor, body }))).toBe('APP_VALIDATION_FAILED');
  });
});

describe('the mark of an agent', () => {
  it('is the spark for every agent until an admin chooses another', async () => {
    expect(await markOf('sales')).toEqual({ kind: 'icon', icon: 'spark' });
    expect(await adminMark('assistant')).toEqual({ kind: 'icon', icon: 'spark', image: null });
  });

  it('is changed only with the right «Агенты», for an agent of the installation', async () => {
    for (const cookie of [olga, petr]) {
      const refused = await saveMark('sales', { kind: 'icon', icon: 'bot' }, cookie);
      expect(refused.status).toBe(403);
      expect(await errorCode(refused)).toBe('APP_ADMIN_FORBIDDEN');
    }
    expect(await errorCode(await saveMark('gone', { kind: 'icon', icon: 'bot' }))).toBe('APP_NOT_FOUND');
    expect((await saveMark('assistant', { kind: 'icon', icon: 'spark' }, anna)).status).toBe(200);
  });

  it('refuses «own picture» without a picture, an unknown icon and an unknown kind', async () => {
    for (const body of [{ kind: 'image', icon: 'spark' }, { kind: 'icon', icon: 'rocket' }, { kind: 'none', icon: 'spark' }, { icon: 'spark' }]) {
      const res = await saveMark('sales', body);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('APP_VALIDATION_FAILED');
    }
    expect(await markOf('sales')).toEqual({ kind: 'icon', icon: 'spark' });
  });

  it('shows the chosen icon for that agent only and writes the change to the audit', async () => {
    const res = await saveMark('sales', { kind: 'icon', icon: 'headset' });
    expect(await json<AgentMarkAdminState>(res)).toEqual({ kind: 'icon', icon: 'headset', image: null });
    expect(await markOf('sales')).toEqual({ kind: 'icon', icon: 'headset' });
    expect(await markOf('assistant', igor)).toEqual({ kind: 'icon', icon: 'spark' });
    const { rows } = await t.db.query<{ target: string; details: { kind: string; icon: string } }>(`SELECT target, details FROM app.admin_audit WHERE action = 'agent.mark' ORDER BY id`);
    expect(rows.at(-1)).toEqual({ target: 'sales', details: { kind: 'icon', icon: 'headset' } });
  });

  it('keeps the picture in the base and serves it by an address that changes with it', async () => {
    const res = await saveMark('sales', { kind: 'image', icon: 'bot', image: png });
    expect(res.status).toBe(200);
    const mark = await markOf('sales');
    expect(mark).toEqual({ kind: 'image', url: expect.stringMatching(/^\/app\/api\/agents\/sales\/image\?v=[0-9a-f]{12}$/) });
    expect(await json<AgentMarkAdminState>(res)).toEqual({ kind: 'image', icon: 'bot', image: { url: urlOf(mark) } });

    const picture = await t.call('GET', urlOf(mark), { cookie: olga });
    expect(picture.status).toBe(200);
    expect(Buffer.from(await picture.arrayBuffer())).toEqual(PNG);
    expect(picture.headers.get('content-type')).toBe('image/png');
    expect(picture.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(picture.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await t.call('GET', urlOf(mark))).status).toBe(401);

    await saveMark('sales', { kind: 'image', icon: 'bot', image: { bytes: WEBP, name: 'face.webp', type: 'image/webp' } });
    const newer = await markOf('sales');
    expect(urlOf(newer)).not.toBe(urlOf(mark));
    // An old address in an open tab still gets the current picture, but it is not kept forever.
    const stale = await t.call('GET', urlOf(mark), { cookie: olga });
    expect(stale.headers.get('content-type')).toBe('image/webp');
    expect(stale.headers.get('cache-control')).toBe('no-cache');

    await saveMark('sales', { kind: 'image', icon: 'bot', image: { bytes: JPEG, name: 'photo.jpg', type: 'image/jpeg' } });
    expect((await t.call('GET', urlOf(await markOf('sales')), { cookie: olga })).headers.get('content-type')).toBe('image/jpeg');
  });

  it('gives the picture to whoever has the agent or sets agents up, and to nobody else', async () => {
    await saveMark('sales', { kind: 'image', icon: 'bot', image: png });
    const url = urlOf(await markOf('sales'));
    for (const cookie of [olga, igor, anna]) expect((await t.call('GET', url, { cookie })).status).toBe(200);
    const hidden = await t.call('GET', url, { cookie: petr });
    expect(hidden.status).toBe(404);
    expect(await errorCode(hidden)).toBe('APP_NOT_FOUND');
    // An agent with no picture has nothing to give.
    expect(await errorCode(await t.call('GET', '/app/api/agents/assistant/image?v=0', { cookie: igor }))).toBe('APP_NOT_FOUND');
  });

  it('keeps the picture when an icon is chosen, so it comes back without a new upload', async () => {
    await saveMark('sales', { kind: 'image', icon: 'bot', image: png });
    const url = urlOf(await markOf('sales'));
    await saveMark('sales', { kind: 'icon', icon: 'star' });
    expect(await markOf('sales')).toEqual({ kind: 'icon', icon: 'star' });
    expect(await adminMark('sales')).toEqual({ kind: 'icon', icon: 'star', image: { url } });
    expect((await saveMark('sales', { kind: 'image', icon: 'star' })).status).toBe(200);
    expect(await markOf('sales')).toEqual({ kind: 'image', url });
  });

  it('refuses what is not a PNG, JPEG or WebP picture of at most 256×256 and keeps the previous one', async () => {
    const before = await markOf('sales');
    const fakes = [
      { bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), name: 'logo.svg', type: 'image/svg+xml' },
      { bytes: Buffer.from('GIF89a\x01\x00\x01\x00'), name: 'logo.gif', type: 'image/gif' },
      { bytes: Buffer.from('just text, named as a picture'), name: 'logo.png', type: 'image/png' },
      // Small in bytes, 16000×16000 in a browser: every employee's tab would unpack a gigabyte.
      { bytes: pngHeader(16_000, 16_000).bytes, name: 'huge.png', type: 'image/png' },
    ];
    for (const image of fakes) {
      const res = await saveMark('sales', { kind: 'image', icon: 'star', image });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('APP_AGENT_IMAGE_INVALID');
    }
    const huge = await saveMark('sales', { kind: 'image', icon: 'star', image: { bytes: Buffer.concat([PNG, Buffer.alloc(600 * 1024)]), name: 'big.png', type: 'image/png' } });
    expect(huge.status).toBe(413);
    expect(await errorCode(huge)).toBe('APP_AGENT_IMAGE_INVALID');
    expect(await markOf('sales')).toEqual(before);
  });
});
