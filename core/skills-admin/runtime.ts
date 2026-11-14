// Skills an employee's agent gets (spec, section 8.15): enabled skills whose scope is the whole
// organisation, a department of the employee or the employee. The entry point of a run asks once
// and puts the folders into the request context, so a skill replaced during an answer does not
// change under it; the sandbox and the file tools see these folders only.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/pool.ts';
import { logEvent } from '../server/log.ts';
import { readSkillArchive, writeSkillFiles } from './archive.ts';
import { skillDir, type SkillsDeps } from './store.ts';

export interface SkillsRuntime {
  skillsFor(userId: string): Promise<string[]>;
  // At the start of the server: unpacks the enabled skills, removes copies nobody uses any more.
  prepare(): Promise<void>;
}

async function unpack(db: Db, skillsDir: string, name: string, sha256: string): Promise<string | null> {
  const dir = skillDir(skillsDir, name, sha256);
  if (existsSync(dir)) return dir;
  const { rows } = await db.query<{ archive: Buffer }>('SELECT archive FROM app.skills WHERE name = $1 AND sha256 = $2', [name, sha256]);
  // Replaced or removed meanwhile: the next request gets what is there then.
  if (!rows[0]) return null;
  writeSkillFiles(readSkillArchive(new Uint8Array(rows[0].archive)).files, dir);
  return dir;
}

export function createSkillsRuntime(deps: SkillsDeps): SkillsRuntime {
  return {
    async skillsFor(userId) {
      const { rows } = await deps.db.query<{ name: string; sha256: string }>(
        `SELECT s.name, s.sha256 FROM app.skills s
          WHERE s.enabled AND (
                s.scope = 'org'
             OR (s.scope = 'users' AND EXISTS (SELECT 1 FROM app.skill_scope sc WHERE sc.skill_name = s.name AND sc.user_id = $1))
             OR (s.scope = 'departments' AND EXISTS (
                  SELECT 1 FROM app.skill_scope sc JOIN app.department_members m ON m.department_id = sc.department_id
                   WHERE sc.skill_name = s.name AND m.user_id = $1)))
          ORDER BY s.name`,
        [userId],
      );
      const dirs = await Promise.all(rows.map((r) => unpack(deps.db, deps.skillsDir, r.name, r.sha256)));
      return dirs.filter((d): d is string => d !== null);
    },

    async prepare() {
      const { rows } = await deps.db.query<{ name: string; sha256: string; enabled: boolean }>('SELECT name, sha256, enabled FROM app.skills');
      const current = new Map(rows.filter((r) => r.enabled).map((r) => [r.name, r.sha256]));
      for (const [name, sha256] of current) await unpack(deps.db, deps.skillsDir, name, sha256);
      if (!existsSync(deps.skillsDir)) return;
      for (const name of readdirSync(deps.skillsDir)) {
        for (const version of existsSync(join(deps.skillsDir, name)) ? readdirSync(join(deps.skillsDir, name)) : []) {
          if (current.get(name) !== version) rmSync(join(deps.skillsDir, name, version), { recursive: true, force: true });
        }
        if (!current.has(name)) rmSync(join(deps.skillsDir, name), { recursive: true, force: true });
      }
      logEvent('info', 'skills_prepared', { skills: [...current.keys()] });
    },
  };
}
