// «Интерфейс» in the admin panel end to end (spec, section 8.17): the agent's mark — an icon, the
// admin's picture or none — chosen by whoever has the right, shown to every employee through /me.
import type { AgentMark, InterfaceAdminState, MeResponse } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from '../server/test-app.ts';
import { JPEG_2X2 as JPEG, PNG_2X2 as PNG, pngHeader, WEBP_2X2 as WEBP } from './test-pictures.ts';

let t: TestApp;
let igor: string;
let olga: string;
let petr: string;

type Form = { agentMark?: string; agentIcon?: string; image?: { bytes: Uint8Array; name: string; type: string } };
function form({ agentMark, agentIcon, image }: Form): FormData {
  const f = new FormData();
  if (agentMark !== undefined) f.append('agentMark', agentMark);
  if (agentIcon !== undefined) f.append('agentIcon', agentIcon);
  if (image) f.append('image', new File([image.bytes], image.name, { type: image.type }));
  return f;
}
const save = (body: Form, cookie = igor) => t.app.request('/app/api/admin/interface', { method: 'PUT', body: form(body), headers: { cookie, origin: TEST_PUBLIC_URL } });
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const markOf = async (cookie: string): Promise<AgentMark> => (await json<MeResponse>(await t.call('GET', '/app/api/me', { cookie }))).interface.agentMark;
const adminState = async () => json<InterfaceAdminState>(await t.call('GET', '/app/api/admin/interface', { cookie: igor }));
const errorCode = async (res: Response) => (await json<{ error: { code: string } }>(res)).error.code;
const png = { bytes: PNG, name: 'logo.png', type: 'image/png' };

beforeAll(async () => {
  t = await createTestApp();
  await t.createUser({ email: 'igor@example.com', roleIds: [await t.roleId('superadmin')] });
  await t.createUser({ email: 'olga@example.com' });
  const designer = (await t.db.query<{ id: string }>(`INSERT INTO app.roles (name, permissions) VALUES ('Оформление', '["interface"]') RETURNING id`)).rows[0]!.id;
  await t.createUser({ email: 'petr@example.com', roleIds: [designer] });
  igor = await t.signIn('igor@example.com');
  olga = await t.signIn('olga@example.com');
  petr = await t.signIn('petr@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('the agent mark of the installation', () => {
  it('is the spark for everyone until an admin chooses another', async () => {
    expect(await markOf(olga)).toEqual({ kind: 'icon', icon: 'spark' });
    expect(await adminState()).toEqual({ agentMark: 'icon', agentIcon: 'spark', image: null });
    expect(await errorCode(await t.call('GET', '/app/api/interface/agent-image?v=0', { cookie: olga }))).toBe('APP_NOT_FOUND');
  });

  it('is changed only by people with the right «Интерфейс»', async () => {
    expect((await t.call('GET', '/app/api/admin/interface', { cookie: olga })).status).toBe(403);
    const refused = await save({ agentMark: 'none', agentIcon: 'spark' }, olga);
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe('APP_ADMIN_FORBIDDEN');
    expect((await save({ agentMark: 'icon', agentIcon: 'spark' }, petr)).status).toBe(200);
    expect((await json<MeResponse>(await t.call('GET', '/app/api/me', { cookie: igor }))).permissions).toContain('interface');
  });

  it('refuses «own picture» without a picture, an unknown icon and an unknown mark', async () => {
    for (const body of [{ agentMark: 'image', agentIcon: 'spark' }, { agentMark: 'icon', agentIcon: 'rocket' }, { agentMark: 'logo', agentIcon: 'spark' }, { agentIcon: 'spark' }]) {
      const res = await save(body);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('APP_VALIDATION_FAILED');
    }
    expect(await markOf(olga)).toEqual({ kind: 'icon', icon: 'spark' });
  });

  it('shows the chosen icon or no mark to every employee and writes the change to the audit', async () => {
    expect((await save({ agentMark: 'icon', agentIcon: 'bot' })).status).toBe(200);
    expect(await markOf(olga)).toEqual({ kind: 'icon', icon: 'bot' });
    expect((await save({ agentMark: 'none', agentIcon: 'bot' })).status).toBe(200);
    expect(await markOf(olga)).toEqual({ kind: 'none' });
    expect(await adminState()).toEqual({ agentMark: 'none', agentIcon: 'bot', image: null });
    const { rows } = await t.db.query<{ details: { agentMark: string } }>(`SELECT details FROM app.admin_audit WHERE action = 'interface.update' ORDER BY id`);
    expect(rows.map((r) => r.details.agentMark)).toEqual(['icon', 'icon', 'none']);
  });

  it('keeps the picture in the base and serves it by an address that changes with it', async () => {
    const res = await save({ agentMark: 'image', agentIcon: 'bot', image: png });
    expect(res.status).toBe(200);
    const mark = await markOf(olga);
    expect(mark).toEqual({ kind: 'image', url: expect.stringMatching(/^\/app\/api\/interface\/agent-image\?v=[0-9a-f]{12}$/) });
    const url = (mark as { url: string }).url;
    expect(await json<InterfaceAdminState>(res)).toEqual({ agentMark: 'image', agentIcon: 'bot', image: { url } });

    const picture = await t.call('GET', url, { cookie: olga });
    expect(picture.status).toBe(200);
    expect(Buffer.from(await picture.arrayBuffer())).toEqual(PNG);
    expect(picture.headers.get('content-type')).toBe('image/png');
    expect(picture.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(picture.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await t.call('GET', url)).status).toBe(401);

    await save({ agentMark: 'image', agentIcon: 'bot', image: { bytes: WEBP, name: 'face.webp', type: 'image/webp' } });
    const newer = await markOf(olga);
    expect(newer).toMatchObject({ kind: 'image' });
    expect((newer as { url: string }).url).not.toBe(url);
    // An old address in an open tab still gets the current picture, but it is not kept forever.
    const stale = await t.call('GET', url, { cookie: olga });
    expect(stale.headers.get('content-type')).toBe('image/webp');
    expect(stale.headers.get('cache-control')).toBe('no-cache');

    await save({ agentMark: 'image', agentIcon: 'bot', image: { bytes: JPEG, name: 'photo.jpg', type: 'image/jpeg' } });
    expect((await t.call('GET', ((await markOf(olga)) as { url: string }).url, { cookie: olga })).headers.get('content-type')).toBe('image/jpeg');
  });

  it('keeps the picture when an icon is chosen, so it comes back without a new upload', async () => {
    await save({ agentMark: 'image', agentIcon: 'bot', image: png });
    const url = ((await markOf(olga)) as { url: string }).url;
    await save({ agentMark: 'icon', agentIcon: 'star' });
    expect(await markOf(olga)).toEqual({ kind: 'icon', icon: 'star' });
    expect(await adminState()).toEqual({ agentMark: 'icon', agentIcon: 'star', image: { url } });
    expect((await save({ agentMark: 'image', agentIcon: 'star' })).status).toBe(200);
    expect(await markOf(olga)).toEqual({ kind: 'image', url });
  });

  it('refuses what is not a PNG, JPEG or WebP picture of at most 256×256 and keeps the previous one', async () => {
    const before = await markOf(olga);
    const fakes = [
      { bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), name: 'logo.svg', type: 'image/svg+xml' },
      { bytes: Buffer.from('GIF89a\x01\x00\x01\x00'), name: 'logo.gif', type: 'image/gif' },
      { bytes: Buffer.from('just text, named as a picture'), name: 'logo.png', type: 'image/png' },
      // Small in bytes, 16000×16000 in a browser: every employee's tab would unpack a gigabyte.
      { bytes: pngHeader(16_000, 16_000).bytes, name: 'huge.png', type: 'image/png' },
    ];
    for (const image of fakes) {
      const res = await save({ agentMark: 'image', agentIcon: 'star', image });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('APP_AGENT_IMAGE_INVALID');
    }
    const huge = await save({ agentMark: 'image', agentIcon: 'star', image: { bytes: Buffer.concat([PNG, Buffer.alloc(600 * 1024)]), name: 'big.png', type: 'image/png' } });
    expect(huge.status).toBe(413);
    expect(await errorCode(huge)).toBe('APP_AGENT_IMAGE_INVALID');
    expect(await markOf(olga)).toEqual(before);
  });
});
