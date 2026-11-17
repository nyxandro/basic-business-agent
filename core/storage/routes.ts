// «Хранилище файлов» of the admin panel (spec, section 8.23): the state is seen with the right «Хранилище
// файлов»; connecting a bucket, changing its keys and disconnecting it — only by a superadmin: all files of
// the organisation go where the bucket is.
import { storageConnectSchema, storageKeysSchema } from '@bba/contracts';
import type { Context, Hono } from 'hono';
import { writeAudit } from '../audit/audit.ts';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { requirePermission } from '../server/guards.ts';
import { access, parseJson, type AppEnv } from '../server/http.ts';
import type { FileStorage } from './engine.ts';

function requireSuperadmin(c: Context<AppEnv>): string {
  const a = access(c);
  if (!a.isSuperadmin) throw appError('APP_ADMIN_FORBIDDEN', 'storage changes need a superadmin', { userMessage: 'Подключать и отключать хранилище файлов может только суперадминистратор.' });
  return a.userId;
}

export function registerStorageRoutes(app: Hono<AppEnv>, deps: { db: Db; storage: FileStorage }): void {
  const right = requirePermission('storage');

  app.get('/app/api/admin/storage', right, async (c) => c.json(await deps.storage.status()));

  app.post('/app/api/admin/storage', right, async (c) => {
    const actor = requireSuperadmin(c);
    const input = await parseJson(c, storageConnectSchema);
    await deps.storage.connect(input);
    await writeAudit(deps.db, { actorUserId: actor, action: 'storage.connect', target: input.bucket, details: { provider: input.provider, endpoint: input.endpoint, region: input.region, prefix: input.prefix } });
    return c.json(await deps.storage.status());
  });

  app.put('/app/api/admin/storage/keys', right, async (c) => {
    const actor = requireSuperadmin(c);
    await deps.storage.updateKeys(await parseJson(c, storageKeysSchema));
    await writeAudit(deps.db, { actorUserId: actor, action: 'storage.keys', target: null });
    return c.json(await deps.storage.status());
  });

  app.delete('/app/api/admin/storage', right, async (c) => {
    const actor = requireSuperadmin(c);
    await deps.storage.disconnect();
    await writeAudit(deps.db, { actorUserId: actor, action: 'storage.disconnect', target: null });
    return c.json(await deps.storage.status());
  });
}
