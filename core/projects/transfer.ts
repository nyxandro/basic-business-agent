// When an employee is removed, their projects — shared and private, archived too — go to the
// administrator who removes them (spec, section 8.20; decisions of the owner 16.11: F3, F9). The
// administrator becomes their creator; colleagues keep their access; the files and the trash move
// to the administrator's folder. Each project moves on its own, so a removal stopped halfway goes on
// from where it stopped.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeAudit } from '../audit/audit.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { logEvent } from '../log/log.ts';
import { projectRoot } from '../workspace/layout.ts';
import { projectArea } from '../storage/areas.ts';
import type { FileStorage } from '../storage/engine.ts';
import { NAME_MAX, UNPINNED_POSITION } from './projects.ts';

// The administrator may have a project of the same name: the given one is named after its creator.
// The name of the former creator in it is cut short, so each try differs in its number whatever its length.
const OWNER_IN_NAME = 30;
const NAME_TRIES = 1000;

async function freeProjectName(db: Pick<Db, 'query'>, userId: string, name: string, formerOwner: string): Promise<string> {
  const taken = async (candidate: string) => ((await db.query('SELECT 1 FROM app.projects WHERE user_id = $1 AND lower(name) = lower($2)', [userId, candidate])).rowCount ?? 0) > 0;
  if (!(await taken(name))) return name;
  const owner = ` (${formerOwner.slice(0, OWNER_IN_NAME).trim()})`;
  for (let n = 1; n <= NAME_TRIES; n++) {
    const suffix = n === 1 ? owner : `${owner} (${n})`;
    const candidate = `${name.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!(await taken(candidate))) return candidate;
  }
  throw new Error(`no free name for project "${name}" of user ${userId} after ${NAME_TRIES} tries`);
}

export async function transferProjects(db: Db, storage: Pick<FileStorage, 'exclusiveIdle'>, workspaceRoot: string, fromUserId: string, toUserId: string): Promise<number> {
  const { rows: former } = await db.query<{ name: string }>('SELECT "name" FROM app."user" WHERE "id" = $1', [fromUserId]);
  const formerOwner = former[0]?.name ?? fromUserId;
  const { rows } = await db.query<{ id: string; name: string }>('SELECT id, name FROM app.projects WHERE user_id = $1 ORDER BY created_at', [fromUserId]);
  for (const project of rows) {
    // The folder first: removal of the employee's folder comes after this step, and a folder left
    // there would go with it.
    const from = projectRoot(workspaceRoot, fromUserId, project.id);
    const to = projectRoot(workspaceRoot, toUserId, project.id);
    // Nothing makes or removes a copy of the project meanwhile, and no answer works in it — its folder would
    // move from under it (spec, section 8.23; the removal is repeated later). In the bucket the project is
    // found by its id alone, so only a copy on the disk moves.
    const moved = await storage.exclusiveIdle(projectArea(project.id, fromUserId), () => {
      if (!existsSync(from)) return false;
      if (existsSync(to)) throw new Error(`project folder ${to} is already there`);
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      return true;
    });
    try {
      await inTransaction(db, async (c) => {
        const name = await freeProjectName(c, toUserId, project.name, formerOwner);
        await c.query('UPDATE app.projects SET user_id = $2, name = $3, updated_at = now() WHERE id = $1', [project.id, toUserId, name]);
        // The new creator sees the project anyway: no line of their own in its list.
        await c.query('DELETE FROM app.project_shares WHERE project_id = $1 AND user_id = $2', [project.id, toUserId]);
        await c.query(
          `INSERT INTO app.project_places (user_id, project_id, position, pinned, seen_at)
           VALUES ($1, $2, $3, false, NULL)
           ON CONFLICT (user_id, project_id) DO UPDATE SET seen_at = NULL`,
          [toUserId, project.id, UNPINNED_POSITION],
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
