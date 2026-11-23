// The look of the chat (spec, section 8.17, section 17.5): «Интерфейс» — whether the chat shows the
// marks of the agents (right «Интерфейс»); the mark of an agent — on its page in «Агенты и промпты»
// (right «Агенты»). An agent's picture is served to whoever has the agent or may set it up.
import { AGENT_IMAGE_MAX_BYTES, agentMarkFormSchema, interfaceSettingsSchema } from '@bba/contracts';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import type { Registry } from '../loader/registry.ts';
import { MULTIPART_OVERHEAD_BYTES } from '../projects/routes.ts';
import { requirePermission } from '../auth/guards.ts';
import { access, parseJson, type AppEnv } from '../http/http.ts';
import { agentImage, agentMarks, DEFAULT_MARK, imageVersion, saveAgentMark } from './agent-marks.ts';
import { checkAgentImage, imageTooLarge } from './image.ts';
import { interfaceAdminState, saveInterfaceSettings } from './store.ts';

const CACHE_FOR_GOOD = 'private, max-age=31536000, immutable';

export function registerInterfaceRoutes(app: Hono<AppEnv>, deps: { db: Db; registry: Pick<Registry, 'get'> }): void {
  const interfaceRight = requirePermission('interface');

  app.get('/app/api/admin/interface', interfaceRight, async (c) => c.json(await interfaceAdminState(deps.db)));
  app.put('/app/api/admin/interface', interfaceRight, async (c) => {
    await saveInterfaceSettings(deps.db, access(c).userId, await parseJson(c, interfaceSettingsSchema));
    return c.json(await interfaceAdminState(deps.db));
  });

  app.put(
    '/app/api/admin/agents/:id/mark',
    requirePermission('agents'),
    // Counts the bytes even without Content-Length, before the form is read into memory.
    bodyLimit({
      maxSize: AGENT_IMAGE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES,
      onError: () => {
        throw imageTooLarge('agent mark form over the limit');
      },
    }),
    async (c) => {
      const agentId = c.req.param('id');
      if (!deps.registry.get(agentId)) throw appError('APP_NOT_FOUND', `agent ${agentId} is not loaded`);
      const fields = await c.req.parseBody();
      const parsed = agentMarkFormSchema.safeParse({ kind: fields.kind, icon: fields.icon });
      if (!parsed.success) throw appError('APP_VALIDATION_FAILED', `bad agent mark form: ${parsed.error.message}`);
      const file = fields.image;
      if (file !== undefined && !(file instanceof File)) throw appError('APP_VALIDATION_FAILED', 'image field is not a file', { userMessage: 'Картинка не получена. Выберите её ещё раз.' });
      const image = file ? checkAgentImage(new Uint8Array(await file.arrayBuffer())) : null;
      await saveAgentMark(deps.db, access(c).userId, agentId, { ...parsed.data, image });
      return c.json((await agentMarks(deps.db)).get(agentId) ?? DEFAULT_MARK);
    },
  );

  // The address agentImagePath() gives.
  app.get('/app/api/agents/:id/image', async (c) => {
    const a = access(c);
    const agentId = c.req.param('id');
    // Like the agent itself: hidden from whoever neither has it nor sets agents up.
    if (!a.isSuperadmin && !a.agentIds.has(agentId) && !a.permissions.has('agents')) throw appError('APP_NOT_FOUND', `agent ${agentId} is not open to the person`);
    const image = await agentImage(deps.db, agentId);
    if (!image) throw appError('APP_NOT_FOUND', `agent ${agentId} has no picture`);
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
