// The organisation's name (spec, section 17.4: org_profile.name): config/app.ts gives the first one
// at the first start; after that it is the admin's, changed in «Профиль организации».
import type { Db } from '../db/pool.ts';

export async function ensureOrgName(db: Db, fromConfig: string): Promise<void> {
  await db.query(
    `INSERT INTO app.org_profile (name) VALUES ($1)
     ON CONFLICT (id) DO UPDATE SET name = COALESCE(app.org_profile.name, EXCLUDED.name)`,
    [fromConfig],
  );
}

export async function orgName(db: Db): Promise<string> {
  const { rows } = await db.query<{ name: string | null }>('SELECT name FROM app.org_profile');
  if (!rows[0]?.name) throw new Error('app.org_profile has no name: ensureOrgName runs at the start of the server');
  return rows[0].name;
}
