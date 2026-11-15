// When an employee is removed, their projects — shared and private, archived too — go to the
// administrator who removes them (spec, section 8.20; decisions of the owner 16.11: F3, F9). The
// administrator becomes their creator; colleagues keep their access; the files and the trash move
// to the administrator's folder. Each project moves on its own, so a removal stopped halfway goes on
// from where it stopped.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeAudit } from '../audit/audit.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { logEvent } from '../server/log.ts';
import { projectRoot } from '../workspace/layout.ts';
import { NAME_MAX } from './projects.ts';

// The administrator may have a project of the same name: the given one is named after its creator.
async function freeProjectName(db: Pick<Db, 'query'>, userId: string, name: string, formerOwner: string): Promise<string> {
  const taken = async (candidate: string) => ((await db.query('SELECT 1 FROM app.projects WHERE user_id = $1 AND lower(name) = lower($2)', [userId, candidate])).rowCount ?? 0) > 0;
  if (!(await taken(name))) return name;
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ` (${formerOwner})` : ` (${formerOwner}) (${n})`;
    const candidate = `${name.slice(0, Math.max(1, NAME_MAX - suffix.length)).trimEnd()}${suffix}`.slice(0, NAME_MAX);
    if (!(await taken(candidate))) return candidate;
  }
}

export async function transferProjects(db: Db, workspaceRoot: string, fromUserId: string, toUserId: string): Promise<number> {
  const { rows: former } = await db.query<{ name: string }>('SELECT "name" FROM app."user" WHERE "id" = $1', [fromUserId]);
  const formerOwner = former[0]?.name ?? fromUserId;
  const { rows } = await db.query<{ id: string; name: string }>('SELECT id, name FROM app.projects WHERE user_id = $1 ORDER BY created_at', [fromUserId]);
  for (const project of rows) {
    // The folder first: removal of the employee's folder comes after this step, and a folder left
    // there would go with it.
    const from = projectRoot(workspaceRoot, fromUserId, project.id);
    const to = projectRoot(workspaceRoot, toUserId, project.id);
    const moved = existsSync(from);
    if (moved) {
      if (existsSync(to)) throw new Error(`project folder ${to} is already there`);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    }
    try {
      await inTransaction(db, async (c) => {
        const name = await freeProjectName(c, toUserId, project.name, formerOwner);
        await c.query('UPDATE app.projects SET user_id = $2, name = $3, updated_at = now() WHERE id = $1', [project.id, toUserId, name]);
        // The new creator sees the project anyway: no line of their own in its list.
        await c.query('DELETE FROM app.project_shares WHERE project_id = $1 AND user_id = $2', [project.id, toUserId]);
        await c.query(
          `INSERT INTO app.project_places (user_id, project_id, position, pinned, seen_at)
           VALUES ($1, $2, (SELECT COALESCE(min(position), 1) - 1 FROM app.project_places WHERE user_id = $1 AND NOT pinned), false, NULL)
           ON CONFLICT (user_id, project_id) DO UPDATE SET seen_at = NULL`,
          [toUserId, project.id],
        );
        await writeAudit(c, { actorUserId: toUserId, action: 'project.transfer', target: project.id, details: { from: fromUserId, name } });
      });
    } catch (error) {
      if (moved) renameSync(to, from);
      throw error;
    }
  }
  if (rows.length > 0) logEvent('info', 'projects_transferred', { from: fromUserId, to: toUserId, projects: rows.length });
  return rows.length;
}
