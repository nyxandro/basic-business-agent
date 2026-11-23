// GET /me: who the person is and what the interface may show them. The answer gathers data of several modules
// (people, voice, organisation profile, models, interface settings), so it lives apart from any of them.
import type { MeResponse } from '@bba/contracts';
import type { Hono } from 'hono';
import { orgName } from '../admin/org-profile.ts';
import type { Db } from '../db/pool.ts';
import { access, type AppEnv } from '../http/http.ts';
import { interfaceAdminState } from '../interface-settings/store.ts';
import { modelsConfigured } from '../models/resolve.ts';
import { recognitionModel } from '../voice/transcribe.ts';

export function registerMeRoutes(app: Hono<AppEnv>, deps: { db: Db }): void {
  app.get('/app/api/me', async (c) => {
    const a = access(c);
    const body: MeResponse = {
      user: { id: a.userId, email: a.email, name: a.name },
      permissions: [...a.permissions],
      isSuperadmin: a.isSuperadmin,
      departmentIds: a.departmentIds,
      voiceAvailable: (await recognitionModel(deps.db)) !== null,
      organisation: { name: await orgName(deps.db) },
      departmentNames: (await deps.db.query<{ name: string }>('SELECT d.name FROM app.department_members m JOIN app.departments d ON d.id = m.department_id WHERE m.user_id = $1 ORDER BY d.name', [a.userId])).rows.map((r) => r.name),
      modelsConfigured: await modelsConfigured(deps.db),
      interface: { showAgentMark: (await interfaceAdminState(deps.db)).showAgentMark },
    };
    return c.json(body);
  });
}
