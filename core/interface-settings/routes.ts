// «Интерфейс» in the admin panel (spec, section 8.17, section 17.5). Changing it needs the
// "interface" right; the agent's picture is served to every signed-in employee.
import { AGENT_IMAGE_MAX_BYTES, interfaceFormSchema } from '@bba/contracts';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { MULTIPART_OVERHEAD_BYTES } from '../projects/routes.ts';
import { requirePermission } from '../server/guards.ts';
import { access, type AppEnv } from '../server/http.ts';
import { checkAgentImage, imageTooLarge } from './image.ts';
import { AGENT_IMAGE_PATH, agentImage, imageVersion, interfaceAdminState, saveInterfaceSettings } from './store.ts';

const CACHE_FOR_GOOD = 'private, max-age=31536000, immutable';

export function registerInterfaceRoutes(app: Hono<AppEnv>, deps: { db: Db }): void {
  const right = requirePermission('interface');

  app.get('/app/api/admin/interface', right, async (c) => c.json(await interfaceAdminState(deps.db)));

  app.put(
    '/app/api/admin/interface',
    right,
    // Counts the bytes even without Content-Length, before the form is read into memory.
    bodyLimit({
      maxSize: AGENT_IMAGE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES,
      onError: () => {
        throw imageTooLarge('interface form over the limit');
      },
    }),
    async (c) => {
      const fields = await c.req.parseBody();
      const parsed = interfaceFormSchema.safeParse({ agentMark: fields.agentMark, agentIcon: fields.agentIcon });
      if (!parsed.success) throw appError('APP_VALIDATION_FAILED', `bad interface form: ${parsed.error.message}`);
      const file = fields.image;
      if (file !== undefined && !(file instanceof File)) throw appError('APP_VALIDATION_FAILED', 'image field is not a file', { userMessage: 'Картинка не получена. Выберите её ещё раз.' });
      const image = file ? checkAgentImage(new Uint8Array(await file.arrayBuffer())) : null;
      await saveInterfaceSettings(deps.db, access(c).userId, { ...parsed.data, image });
      return c.json(await interfaceAdminState(deps.db));
    },
  );

  app.get(AGENT_IMAGE_PATH, async (c) => {
    const image = await agentImage(deps.db);
    if (!image) throw appError('APP_NOT_FOUND', 'no agent image');
    // An address of an older picture, left in an open tab, still gets the current one, but the
    // browser must not keep it under that address for good.
    const current = c.req.query('v') === imageVersion(image.sha256);
    return c.body(new Uint8Array(image.bytes), 200, {
      'Content-Type': image.type,
      'Cache-Control': current ? CACHE_FOR_GOOD : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
  });
}
