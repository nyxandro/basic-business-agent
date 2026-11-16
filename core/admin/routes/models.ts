// «Нейросеть» (spec, scenario 9, section 17.5): the catalog of models, provider keys, the pool of
// ChatGPT accounts and the organisation's choice of models. Needs the "models" right of the role.
import { chatgptLoginStartSchema, modelCreateSchema, modelKeyCreateSchema, modelSettingsSchema, modelUpdateSchema } from '@bba/contracts';
import type { Hono } from 'hono';
import type { ModelCatalog } from '../../models/catalog.ts';
import type { ChatGptAccounts } from '../../models/chatgpt-accounts.ts';
import { requirePermission } from '../../server/guards.ts';
import { access, parseJson, type AppEnv } from '../../server/http.ts';

export function registerModelRoutes(app: Hono<AppEnv>, catalog: ModelCatalog, accounts: ChatGptAccounts): void {
  const models = requirePermission('models');

  app.get('/app/api/admin/models', models, async (c) => c.json(await catalog.list()));

  app.post('/app/api/admin/models', models, async (c) => {
    const input = await parseJson(c, modelCreateSchema);
    return c.json(await catalog.create(access(c).userId, input), 201);
  });

  // Before /:id, so that "settings" is not taken for a model id.
  app.put('/app/api/admin/models/settings', models, async (c) => {
    const input = await parseJson(c, modelSettingsSchema);
    return c.json(await catalog.updateSettings(access(c).userId, input));
  });

  app.put('/app/api/admin/models/:id', models, async (c) => {
    const change = await parseJson(c, modelUpdateSchema);
    const a = access(c);
    return c.json(await catalog.update({ userId: a.userId, isSuperadmin: a.isSuperadmin }, c.req.param('id'), change));
  });

  app.delete('/app/api/admin/models/:id', models, async (c) => {
    await catalog.remove(access(c).userId, c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/app/api/admin/models/:id/keys', models, async (c) => {
    const { key } = await parseJson(c, modelKeyCreateSchema);
    return c.json(await catalog.addKey(access(c).userId, c.req.param('id'), key), 201);
  });

  app.delete('/app/api/admin/models/:id/keys/:keyId', models, async (c) => {
    await catalog.removeKey(access(c).userId, c.req.param('id'), c.req.param('keyId'));
    return c.json({ ok: true });
  });

  app.post('/app/api/admin/chatgpt/logins', models, async (c) => {
    const { accountId } = await parseJson(c, chatgptLoginStartSchema);
    return c.json(await accounts.startLogin(access(c).userId, accountId), 201);
  });

  app.get('/app/api/admin/chatgpt/logins/:id', models, async (c) => c.json(await accounts.pollLogin(access(c).userId, c.req.param('id'))));

  app.delete('/app/api/admin/chatgpt/accounts/:id', models, async (c) => {
    await accounts.disconnect(access(c).userId, c.req.param('id'));
    return c.json({ ok: true });
  });
}
