// The trash of a project (spec, section 8.20; decision of the owner 16.11): nothing of a project goes
// at once. A file removed by the page's button is moved into the trash. The agent may remove files
// in any way — a tool, `rm`, a script of a skill — and no single place sees all of them, so before
// each answer in a project its files are remembered as a snapshot of second links to the same files
// on the disk (no copying); after the answer, whatever left the folder goes from the snapshot into
// the trash. A file the answer replaced by a new one leaves its previous version there; one the
// agent's own tools are about to write over is copied into the snapshot first. 30 days later the
// trash empties itself.
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { TrashBatchDto, TrashRestore } from '@bba/contracts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { logEvent } from '../server/log.ts';
import { contextRoot, freeName, moveFileOutOf, projectRoot, removeFileInside, resolveInside } from '../workspace/layout.ts';

export const TRASH_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const TRASH = 'trash';
const SNAPSHOTS = '.snapshots';
// The name of a previous version brought back next to the file it was replaced by.
const PREVIOUS_VERSION = ' (прежняя версия)';

export interface SnapshotRun {
  projectId: string;
  ownerId: string;
  userId: string;
  threadId: string;
}

export interface ProjectSnapshot extends SnapshotRun {
  id: string;
}

interface Meta {
  userId: string;
  threadId: string;
}

export const trashDir = (workspaceRoot: string, ownerId: string, projectId: string) => join(projectRoot(workspaceRoot, ownerId, projectId), TRASH);
const snapshotsDir = (workspaceRoot: string, ownerId: string, projectId: string) => join(projectRoot(workspaceRoot, ownerId, projectId), SNAPSHOTS);
const snapshotDir = (workspaceRoot: string, s: { ownerId: string; projectId: string; id: string }) => join(snapshotsDir(workspaceRoot, s.ownerId, s.projectId), s.id);

const isGone = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

// Regular files of a folder by their path from it. Hidden entries (".renders" of the skills, a
// snapshot) are working files, not the person's: they are skipped, as in the file lists.
function filesOf(dir: string, withHidden = false): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (current: string) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (isGone(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (!withHidden && entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.set(relative(dir, full), lstatSync(full).ino);
    }
  };
  walk(dir);
  return out;
}

// Before an answer in a project: second links to its files, so a file the answer removes keeps its
// bytes. Who ran the answer is written beside, for a snapshot left by a stopped server.
export function takeSnapshot(workspaceRoot: string, run: SnapshotRun): ProjectSnapshot {
  const snapshot = { ...run, id: randomUUID() };
  const files = contextRoot(workspaceRoot, run.ownerId, run.projectId);
  const dir = snapshotDir(workspaceRoot, snapshot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}.json`, JSON.stringify({ userId: run.userId, threadId: run.threadId } satisfies Meta));
  for (const path of filesOf(files).keys()) {
    const link = join(dir, path);
    mkdirSync(dirname(link), { recursive: true });
    try {
      linkSync(join(files, path), link);
    } catch (error) {
      // Removed or replaced by a folder while the snapshot was taken: nothing to keep.
      if (!isGone(error) && (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  }
  return snapshot;
}

// The agent's own tools are about to write over these files: what the snapshot links to would change
// in place, so the snapshot gets a copy of each first — once per answer.
export function keepBeforeWrite(workspaceRoot: string, snapshot: Pick<ProjectSnapshot, 'ownerId' | 'projectId' | 'id'>, paths: string[]): void {
  const files = contextRoot(workspaceRoot, snapshot.ownerId, snapshot.projectId);
  const dir = snapshotDir(workspaceRoot, snapshot);
  for (const path of paths) {
    let rel: string;
    try {
      rel = relative(files, resolveInside(files, path));
    } catch {
      continue; // A path out of the folder: the tool refuses it itself.
    }
    const kept = join(dir, rel);
    const live = join(files, rel);
    const keptStat = lstatSync(kept, { throwIfNoEntry: false });
    const liveStat = lstatSync(live, { throwIfNoEntry: false });
    if (!keptStat?.isFile() || !liveStat?.isFile() || keptStat.ino !== liveStat.ino) continue;
    const temp = `${kept}.copy-${randomUUID()}`;
    copyFileSync(live, temp);
    renameSync(temp, kept);
  }
}

const sameBytes = (a: string, b: string) => {
  const [x, y] = [lstatSync(a), lstatSync(b)];
  return x.size === y.size && readFileSync(a).equals(readFileSync(b));
};

// One project at a time: two answers in it end at once and see the same removed file.
const settling = new Map<string, Promise<unknown>>();

function oneAtATime<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  const next = (settling.get(projectId) ?? Promise.resolve()).then(work, work);
  settling.set(projectId, next.catch(() => undefined));
  return next;
}

// After the answer, whatever way it ended: what left the folder goes into the trash, a file replaced
// by a new one leaves its previous version there. A project removed or given to another person
// meanwhile leaves no folder here: one the agent's tools made again is removed (spec, F5).
export function settleSnapshot(db: Db, workspaceRoot: string, snapshot: ProjectSnapshot): Promise<number> {
  return oneAtATime(snapshot.projectId, async () => {
    const dir = snapshotDir(workspaceRoot, snapshot);
    try {
      const { rows } = await db.query<{ user_id: string }>('SELECT user_id FROM app.projects WHERE id = $1', [snapshot.projectId]);
      if (rows[0]?.user_id !== snapshot.ownerId) {
        rmSync(projectRoot(workspaceRoot, snapshot.ownerId, snapshot.projectId), { recursive: true, force: true });
        return 0;
      }
      const files = contextRoot(workspaceRoot, snapshot.ownerId, snapshot.projectId);
      const trash = trashDir(workspaceRoot, snapshot.ownerId, snapshot.projectId);
      const live = filesOf(files, true);
      const liveInodes = new Set(live.values());
      const trashed = new Set(filesOf(trash, true).values());
      const now = new Date();
      let added = 0;
      for (const [path, ino] of filesOf(dir, true)) {
        const kept = join(dir, path);
        const liveIno = live.get(path);
        let kind: 'deleted' | 'previous_version';
        if (liveIno !== undefined) {
          // Still there: the same file, or a new one with the same bytes, is no news.
          if (liveIno === ino || sameBytes(kept, join(files, path))) continue;
          kind = 'previous_version';
        } else {
          // Moved or renamed in the folder, or already in the trash (another answer, the page).
          if (liveInodes.has(ino) || trashed.has(ino)) continue;
          kind = 'deleted';
        }
        const id = randomUUID();
        const bytes = lstatSync(kept).size;
        mkdirSync(trash, { recursive: true });
        renameSync(kept, join(trash, id));
        await db.query(
          `INSERT INTO app.project_trash (id, project_id, path, bytes, kind, via, deleted_by, thread_id, batch_id, deleted_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, 'agent', (SELECT "id" FROM app."user" WHERE "id" = $6), $7, $8, $9, $10)`,
          [id, snapshot.projectId, path, bytes, kind, snapshot.userId, snapshot.threadId, snapshot.id, now, new Date(now.getTime() + TRASH_KEEP_DAYS * DAY_MS)],
        );
        added++;
      }
      if (added > 0) logEvent('info', 'project_trash_added', { projectId: snapshot.projectId, userId: snapshot.userId, files: added });
      return added;
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(`${dir}.json`, { force: true });
    }
  });
}

// The page's «Удалить»: the file goes into the trash at once (`trashId`). A link the agent made is just
// removed (`trashId` null); no such file — null.
export async function trashFromPage(db: Db, workspaceRoot: string, project: { id: string; user_id: string }, path: string, userId: string): Promise<{ trashId: string | null } | null> {
  const files = contextRoot(workspaceRoot, project.user_id, project.id);
  const rel = relative(files, resolveInside(files, path));
  const id = randomUUID();
  const moved = moveFileOutOf(files, path, join(trashDir(workspaceRoot, project.user_id, project.id), id));
  if (!moved) return removeFileInside(files, path) ? { trashId: null } : null;
  const now = new Date();
  await db.query(
    `INSERT INTO app.project_trash (id, project_id, path, bytes, kind, via, deleted_by, thread_id, batch_id, deleted_at, expires_at)
     VALUES ($1, $2, $3, $4, 'deleted', 'page', $5, NULL, $6, $7, $8)`,
    [id, project.id, rel, moved.bytes, userId, randomUUID(), now, new Date(now.getTime() + TRASH_KEEP_DAYS * DAY_MS)],
  );
  return { trashId: id };
}

interface TrashRow {
  id: string;
  path: string;
  bytes: string;
  kind: 'deleted' | 'previous_version';
  via: 'page' | 'agent';
  deleted_by_name: string | null;
  batch_id: string;
  deleted_at: Date;
  expires_at: Date;
}

export async function listTrash(db: Db, projectId: string): Promise<TrashBatchDto[]> {
  const { rows } = await db.query<TrashRow>(
    `SELECT t.id, t.path, t.bytes, t.kind, t.via, u."name" AS deleted_by_name, t.batch_id, t.deleted_at, t.expires_at
       FROM app.project_trash t LEFT JOIN app."user" u ON u."id" = t.deleted_by
      WHERE t.project_id = $1 ORDER BY t.deleted_at DESC, t.batch_id, t.path`,
    [projectId],
  );
  const batches = new Map<string, TrashBatchDto>();
  for (const r of rows) {
    const batch = batches.get(r.batch_id) ?? { id: r.batch_id, via: r.via, deletedBy: r.deleted_by_name, deletedAt: r.deleted_at.toISOString(), items: [] };
    batch.items.push({ id: r.id, path: r.path, bytes: Number(r.bytes), kind: r.kind, expiresAt: r.expires_at.toISOString() });
    batches.set(r.batch_id, batch);
  }
  return [...batches.values()];
}

// The last removed file of this path still in the trash: «Скачать» of the chat finds it there.
export async function trashedAt(db: Db, projectId: string, path: string): Promise<{ id: string; expiresAt: Date } | null> {
  const { rows } = await db.query<{ id: string; expires_at: Date }>(
    "SELECT id, expires_at FROM app.project_trash WHERE project_id = $1 AND path = $2 AND kind = 'deleted' ORDER BY deleted_at DESC LIMIT 1",
    [projectId, path],
  );
  return rows[0] ? { id: rows[0].id, expiresAt: rows[0].expires_at } : null;
}

export async function trashItem(db: Db, projectId: string, trashId: string): Promise<{ id: string; path: string } | null> {
  if (!/^[0-9a-f-]{36}$/.test(trashId)) return null;
  const { rows } = await db.query<{ id: string; path: string }>('SELECT id, path FROM app.project_trash WHERE project_id = $1 AND id = $2', [projectId, trashId]);
  return rows[0] ?? null;
}

// Back to the place it was removed from (its folders made again); a taken name gets «(2)»; a previous
// version comes back next to the file that replaced it. Returns the paths the files have now.
export async function restoreFromTrash(db: Db, workspaceRoot: string, project: { id: string; user_id: string }, what: TrashRestore): Promise<string[]> {
  const files = contextRoot(workspaceRoot, project.user_id, project.id);
  const trash = trashDir(workspaceRoot, project.user_id, project.id);
  return inTransaction(db, async (c) => {
    const { rows } = await c.query<{ id: string; path: string; kind: 'deleted' | 'previous_version' }>(
      'ids' in what
        ? 'SELECT id, path, kind FROM app.project_trash WHERE project_id = $1 AND id = ANY($2::uuid[]) ORDER BY path FOR UPDATE'
        : 'SELECT id, path, kind FROM app.project_trash WHERE project_id = $1 AND batch_id = $2::uuid ORDER BY path FOR UPDATE',
      [project.id, 'ids' in what ? what.ids : what.batchId],
    );
    if (rows.length === 0 || ('ids' in what && rows.length !== new Set(what.ids).size)) {
      throw appError('APP_NOT_FOUND', `trash items of project ${project.id} are gone`, { userMessage: 'Этого файла в корзине уже нет. Список обновлён.' });
    }
    const restored: string[] = [];
    for (const row of rows) {
      const target = resolveInside(files, row.path);
      const folder = dirname(target);
      mkdirSync(folder, { recursive: true });
      const wanted = row.kind === 'previous_version' ? `${basename(row.path, extname(row.path))}${PREVIOUS_VERSION}${extname(row.path)}` : basename(row.path);
      const name = freeName(folder, wanted);
      try {
        renameSync(join(trash, row.id), join(folder, name));
      } catch (error) {
        // The file of the row is gone (a stopped purge): nothing to bring back, the row goes too.
        if (!isGone(error)) throw error;
        await c.query('DELETE FROM app.project_trash WHERE id = $1', [row.id]);
        logEvent('warn', 'project_trash_file_missing', { projectId: project.id, trashId: row.id });
        continue;
      }
      await c.query('DELETE FROM app.project_trash WHERE id = $1', [row.id]);
      restored.push(relative(files, join(folder, name)));
    }
    return restored;
  });
}

// Files older than 30 days leave the trash for good: the row first, then the file; a file of a trash
// with no row (left by a stopped removal) goes too.
export async function purgeTrash(db: Db, workspaceRoot: string, now = new Date()): Promise<{ files: number; bytes: number }> {
  const { rows } = await db.query<{ id: string; project_id: string; user_id: string; bytes: string }>(
    `DELETE FROM app.project_trash t USING app.projects p WHERE p.id = t.project_id AND t.expires_at <= $1
     RETURNING t.id, t.project_id, p.user_id, t.bytes`,
    [now],
  );
  let bytes = 0;
  for (const r of rows) {
    rmSync(join(trashDir(workspaceRoot, r.user_id, r.project_id), r.id), { force: true });
    bytes += Number(r.bytes);
  }
  if (rows.length > 0) logEvent('info', 'project_trash_purged', { files: rows.length, bytes });
  return { files: rows.length, bytes };
}

// At the start of the server: answers a stopped server left unfinished are settled from their
// snapshots; folders of projects that are gone, or given to another person, are removed; files of a
// trash with no row are removed.
export async function recoverProjectFolders(db: Db, workspaceRoot: string): Promise<void> {
  const { rows } = await db.query<{ id: string; user_id: string }>('SELECT id, user_id FROM app.projects');
  const owners = new Map(rows.map((r) => [r.id, r.user_id]));
  const { rows: items } = await db.query<{ id: string }>('SELECT id FROM app.project_trash');
  const known = new Set(items.map((r) => r.id));
  if (!existsSync(workspaceRoot)) return;
  for (const userId of readdirSync(workspaceRoot)) {
    const projects = join(workspaceRoot, userId, 'projects');
    if (!existsSync(projects)) continue;
    for (const projectId of readdirSync(projects)) {
      if (owners.get(projectId) !== userId) {
        rmSync(join(projects, projectId), { recursive: true, force: true });
        logEvent('warn', 'project_folder_removed', { projectId, userId });
        continue;
      }
      const snapshots = join(projects, projectId, SNAPSHOTS);
      for (const entry of existsSync(snapshots) ? readdirSync(snapshots) : []) {
        if (!entry.endsWith('.json')) continue;
        const meta = JSON.parse(readFileSync(join(snapshots, entry), 'utf8')) as Meta;
        await settleSnapshot(db, workspaceRoot, { id: entry.slice(0, -'.json'.length), projectId, ownerId: userId, userId: meta.userId, threadId: meta.threadId });
      }
      // A snapshot whose note of who ran it was never written: nothing to settle it for.
      for (const entry of existsSync(snapshots) ? readdirSync(snapshots) : []) rmSync(join(snapshots, entry), { recursive: true, force: true });
      const trash = join(projects, projectId, TRASH);
      for (const file of existsSync(trash) ? readdirSync(trash) : []) if (!known.has(file)) rmSync(join(trash, file), { force: true });
    }
  }
}

// The trash empties itself: at the start of the server and every hour. A failure leaves the files
// for the next hour and is written to the log (`project_trash_purge_failed`).
export const TRASH_PURGE_EVERY_MS = 60 * 60 * 1000;

export function startTrashPurge(db: Db, workspaceRoot: string): () => void {
  const purge = () => void purgeTrash(db, workspaceRoot).catch((error: unknown) => logEvent('error', 'project_trash_purge_failed', { code: 'APP_INTERNAL', error }));
  purge();
  const timer = setInterval(purge, TRASH_PURGE_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
