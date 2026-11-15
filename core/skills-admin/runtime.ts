// Skills an employee's agent gets (spec, sections 8.15 and 8.18): the system skills of the core
// first, then the enabled uploaded skills whose scope is the whole organisation, a department of
// the employee or the employee. The entry point of a run asks once and puts the folders into the
// request context, so a skill replaced during an answer does not change under it; the sandbox and
// the file tools see these folders only.
import { existsSync } from 'node:fs';
import { writeAudit } from '../audit/audit.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { logEvent } from '../server/log.ts';
import { readSkillArchive, writeSkillFiles } from './archive.ts';
import { removeSkillCopies, skillDir, type SkillsDeps } from './store.ts';

export interface SkillsRuntime {
  skillsFor(userId: string): Promise<string[]>;
  // At the start of the server: removes uploaded skills a system skill took the name of, unpacks
  // the enabled skills, removes copies nobody uses any more.
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

// A skill uploaded under a name the core later gave a system skill: two skills of one name would
// confuse the agent, and the system one cannot be switched off — so the upload goes.
async function removeSuperseded(deps: SkillsDeps): Promise<void> {
  const names = deps.systemSkills.map((s) => s.name);
  const removed = await inTransaction(deps.db, async (c) => {
    const { rows } = await c.query<{ name: string; sha256: string }>('DELETE FROM app.skills WHERE name = ANY($1) RETURNING name, sha256', [names]);
    for (const r of rows) await writeAudit(c, { actorUserId: null, action: 'skill.superseded', target: r.name, details: { sha256: r.sha256, reason: 'a system skill of the core has this name' } });
    return rows;
  });
  for (const r of removed) logEvent('warn', 'skill_superseded_by_system', { skill: r.name, sha256: r.sha256 });
}

export function createSkillsRuntime(deps: SkillsDeps): SkillsRuntime {
  const systemDirs = deps.systemSkills.map((s) => s.dir);
  const systemNames = deps.systemSkills.map((s) => s.name);
  return {
    async skillsFor(userId) {
      const { rows } = await deps.db.query<{ name: string; sha256: string }>(
        `SELECT s.name, s.sha256 FROM app.skills s
          WHERE s.enabled AND s.name <> ALL($2) AND (
                s.scope = 'org'
             OR (s.scope = 'users' AND EXISTS (SELECT 1 FROM app.skill_scope sc WHERE sc.skill_name = s.name AND sc.user_id = $1))
             OR (s.scope = 'departments' AND EXISTS (
                  SELECT 1 FROM app.skill_scope sc JOIN app.department_members m ON m.department_id = sc.department_id
                   WHERE sc.skill_name = s.name AND m.user_id = $1)))
          ORDER BY s.name`,
        [userId, systemNames],
      );
      const dirs = await Promise.all(rows.map((r) => unpack(deps.db, deps.skillsDir, r.name, r.sha256)));
      return [...systemDirs, ...dirs.filter((d): d is string => d !== null)];
    },

    async prepare() {
      await removeSuperseded(deps);
      const { rows } = await deps.db.query<{ name: string; sha256: string; enabled: boolean }>('SELECT name, sha256, enabled FROM app.skills');
      const current = new Map(rows.filter((r) => r.enabled).map((r) => [r.name, r.sha256]));
      for (const [name, sha256] of current) await unpack(deps.db, deps.skillsDir, name, sha256);
      removeSkillCopies(deps.skillsDir, (name, sha256) => current.get(name) !== sha256);
      logEvent('info', 'skills_prepared', { system: systemNames, skills: [...current.keys()] });
    },
  };
}
