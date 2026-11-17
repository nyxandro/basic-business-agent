// The trash of a project (spec, section 8.20; decision of the owner 16.11): nothing of a project goes
// at once. A file removed by the page's button is moved into the trash. The agent may remove files
// in any way — a tool, `rm`, a script of a skill — and no single place sees all of them, so before
// each answer in a project its files are remembered as a snapshot of second links to the same files
// on the disk (no copying); after the answer, whatever left the folder goes from the snapshot into
// the trash. A file the answer replaced by a new one leaves its previous version there; one the
// agent's own tools are about to write over is copied into the snapshot first. 30 days later the
// trash empties itself. The folder is the agent's to change at any moment, so it is read only through
// core/workspace/held-folder.ts.
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { TrashBatchDto, TrashRestore } from '@bba/contracts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { logEvent } from '../server/log.ts';
import { copyOpened, inFolderOf, openRegular, sameContent, walkRegularFiles } from '../workspace/held-folder.ts';
import { contextRoot, freeName, moveFileOutOf, projectRoot, removeFileInside, resolveInside } from '../workspace/layout.ts';
import { projectArea } from '../storage/areas.ts';
import type { FileStorage } from '../storage/engine.ts';

export const TRASH_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const TRASH = 'trash';
const SNAPSHOTS = '.snapshots';
// The name of a previous version brought back next to the file it was replaced by.
const PREVIOUS_VERSION = ' (прежняя версия)';

export interface SnapshotRun {
  projectId: string;
  ownerId: string;
  // Null for a snapshot a stopped server left without a readable note of who ran it.
  userId: string | null;
  threadId: string | null;
}

export interface ProjectSnapshot extends SnapshotRun {
  id: string;
}

interface Meta {
  userId: string | null;
  threadId: string | null;
}

export const trashDir = (workspaceRoot: string, ownerId: string, projectId: string) => join(projectRoot(workspaceRoot, ownerId, projectId), TRASH);
const snapshotsDir = (workspaceRoot: string, ownerId: string, projectId: string) => join(projectRoot(workspaceRoot, ownerId, projectId), SNAPSHOTS);
const snapshotDir = (workspaceRoot: string, s: { ownerId: string; projectId: string; id: string }) => join(snapshotsDir(workspaceRoot, s.ownerId, s.projectId), s.id);
const expiry = (from: Date) => new Date(from.getTime() + TRASH_KEEP_DAYS * DAY_MS);

const isGone = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

// Answers running now in each project on this server: one that ran beside another cannot say for sure
// whose removals it saw, and its rows say so.
const running = new Map<string, Map<string, { overlapped: boolean }>>();

function startRunning(projectId: string, id: string): void {
  const runs = running.get(projectId) ?? new Map<string, { overlapped: boolean }>();
  const overlapped = runs.size > 0;
  if (overlapped) for (const run of runs.values()) run.overlapped = true;
  runs.set(id, { overlapped });
  running.set(projectId, runs);
}

function stopRunning(projectId: string, id: string): boolean {
  const runs = running.get(projectId);
  const overlapped = runs?.get(id)?.overlapped ?? false;
  runs?.delete(id);
  if (runs?.size === 0) running.delete(projectId);
  return overlapped;
}

// Before an answer in a project: second links to its files, so a file the answer removes keeps its
// bytes. Who ran the answer is written beside, for a snapshot left by a stopped server.
export function takeSnapshot(workspaceRoot: string, run: SnapshotRun): ProjectSnapshot {
  const snapshot = { ...run, id: randomUUID() };
  const files = contextRoot(workspaceRoot, run.ownerId, run.projectId);
  const dir = snapshotDir(workspaceRoot, snapshot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}.json`, JSON.stringify({ userId: run.userId, threadId: run.threadId } satisfies Meta));
  walkRegularFiles(files, (file) => {
    const link = join(dir, file.rel);
    mkdirSync(dirname(link), { recursive: true });
    try {
      // The opened folder's entry itself: a link put there meanwhile is linked as a link, never followed.
      linkSync(file.path, link);
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  });
  startRunning(run.projectId, snapshot.id);
  return snapshot;
}

// The agent's own tools are about to write over these files in place: what the snapshot links to would
// change with them, so the snapshot gets a copy of each first — once per answer.
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
    const keptStat = lstatSync(kept, { throwIfNoEntry: false });
    if (!keptStat?.isFile()) continue;
    inFolderOf(files, rel, false, (folder, name) => {
      const entry = join(folder, name);
      const fd = openRegular(entry);
      if (fd === null) return;
      try {
        // Copied already in this answer, or not the remembered file any more: nothing to keep.
        if (lstatSync(entry).ino !== keptStat.ino) return;
        const temp = `${kept}.copy-${randomUUID()}`;
        copyOpened(fd, temp);
        renameSync(temp, kept);
      } finally {
        closeSync(fd);
      }
    });
  }
}

// One project at a time: two answers in it end at once and see the same removed file.
const settling = new Map<string, Promise<unknown>>();

function oneAtATime<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  const next = (settling.get(projectId) ?? Promise.resolve()).then(work, work);
  settling.set(projectId, next.catch(() => undefined));
  return next;
}

interface NewItem {
  projectId: string;
  path: string;
  kind: 'deleted' | 'previous_version';
  userId: string | null;
  threadId: string | null;
  batchId: string;
  overlapped: boolean;
}

// The row first: a file moved and never written down would be taken for a stray one and removed. The
// file failing to move takes its row back.
async function addToTrash(db: Db, trash: string, kept: string, item: NewItem): Promise<void> {
  const id = randomUUID();
  const now = new Date();
  await db.query(
    `INSERT INTO app.project_trash (id, project_id, path, bytes, kind, via, deleted_by, thread_id, batch_id, deleted_at, expires_at, overlapped)
     VALUES ($1, $2, $3, $4, $5, 'agent', (SELECT "id" FROM app."user" WHERE "id" = $6), $7, $8, $9, $10, $11)`,
    [id, item.projectId, item.path, lstatSync(kept).size, item.kind, item.userId, item.threadId, item.batchId, now, expiry(now), item.overlapped],
  );
  mkdirSync(trash, { recursive: true });
  try {
    renameSync(kept, join(trash, id));
  } catch (error) {
    await db.query('DELETE FROM app.project_trash WHERE id = $1', [id]);
    throw error;
  }
}

// After the answer, whatever way it ended: what left the folder goes into the trash, a file replaced
// by a new one leaves its previous version there. A project removed or given to another person
// meanwhile leaves no folder here: one the agent's tools made again is removed (spec, F5). A failure
// leaves the rest of the snapshot for the start of the server.
export function settleSnapshot(db: Db, workspaceRoot: string, snapshot: ProjectSnapshot): Promise<number> {
  const overlapped = stopRunning(snapshot.projectId, snapshot.id);
  return oneAtATime(snapshot.projectId, async () => {
    const dir = snapshotDir(workspaceRoot, snapshot);
    const { rows } = await db.query<{ user_id: string }>('SELECT user_id FROM app.projects WHERE id = $1', [snapshot.projectId]);
    if (rows[0]?.user_id !== snapshot.ownerId) {
      rmSync(projectRoot(workspaceRoot, snapshot.ownerId, snapshot.projectId), { recursive: true, force: true });
      return 0;
    }
    const files = contextRoot(workspaceRoot, snapshot.ownerId, snapshot.projectId);
    const trash = trashDir(workspaceRoot, snapshot.ownerId, snapshot.projectId);
    const kept = new Map<string, { ino: number; path: string }>();
    walkRegularFiles(dir, (file) => kept.set(file.rel, { ino: file.ino, path: join(dir, file.rel) }), true);
    // The folder as the answer left it: its files, and which remembered ones now hold other bytes.
    const liveInodes = new Set<number>();
    const livePaths = new Set<string>();
    const changed = new Set<string>();
    walkRegularFiles(
      files,
      (file) => {
        liveInodes.add(file.ino);
        livePaths.add(file.rel);
        const before = kept.get(file.rel);
        if (!before || before.ino === file.ino) return;
        const now = openRegular(file.path);
        const was = openRegular(before.path);
        try {
          if (now === null || was === null || !sameContent(now, was)) changed.add(file.rel);
        } finally {
          if (now !== null) closeSync(now);
          if (was !== null) closeSync(was);
        }
      },
      true,
    );
    const trashed = new Set<number>();
    walkRegularFiles(trash, (file) => trashed.add(file.ino), true);
    let added = 0;
    for (const [path, { ino, path: keptPath }] of kept) {
      // Moved or renamed in the folder, or already in the trash (another answer, the page).
      if (liveInodes.has(ino) || trashed.has(ino)) continue;
      // Still there with the same bytes: no news.
      if (livePaths.has(path) && !changed.has(path)) continue;
      await addToTrash(db, trash, keptPath, { projectId: snapshot.projectId, path, kind: livePaths.has(path) ? 'previous_version' : 'deleted', userId: snapshot.userId, threadId: snapshot.threadId, batchId: snapshot.id, overlapped });
      trashed.add(ino);
      added++;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.json`, { force: true });
    if (added > 0) logEvent('info', 'project_trash_added', { projectId: snapshot.projectId, userId: snapshot.userId, files: added, overlapped });
    return added;
  });
}

// The page's «Удалить»: the file goes into the trash at once (`trashId`). A link the agent made is just
// removed (`trashId` null); no such file — null.
export async function trashFromPage(db: Db, workspaceRoot: string, project: { id: string; user_id: string }, path: string, userId: string): Promise<{ trashId: string | null } | null> {
  const files = contextRoot(workspaceRoot, project.user_id, project.id);
  const rel = relative(files, resolveInside(files, path));
  const id = randomUUID();
  const now = new Date();
  // The row first, so a file in the trash always has its row; no file to move takes the row back.
  await db.query(
    `INSERT INTO app.project_trash (id, project_id, path, bytes, kind, via, deleted_by, thread_id, batch_id, deleted_at, expires_at, overlapped)
     VALUES ($1, $2, $3, 0, 'deleted', 'page', $4, NULL, $5, $6, $7, false)`,
    [id, project.id, rel, userId, randomUUID(), now, expiry(now)],
  );
  let moved: { bytes: number } | null;
  try {
    moved = moveFileOutOf(files, path, join(trashDir(workspaceRoot, project.user_id, project.id), id));
  } catch (error) {
    await db.query('DELETE FROM app.project_trash WHERE id = $1', [id]);
    throw error;
  }
  if (!moved) {
    await db.query('DELETE FROM app.project_trash WHERE id = $1', [id]);
    return removeFileInside(files, path) ? { trashId: null } : null;
  }
  await db.query('UPDATE app.project_trash SET bytes = $2 WHERE id = $1', [id, moved.bytes]);
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
  overlapped: boolean;
}

export async function listTrash(db: Db, projectId: string): Promise<TrashBatchDto[]> {
  const { rows } = await db.query<TrashRow>(
    `SELECT t.id, t.path, t.bytes, t.kind, t.via, u."name" AS deleted_by_name, t.batch_id, t.deleted_at, t.expires_at, t.overlapped
       FROM app.project_trash t LEFT JOIN app."user" u ON u."id" = t.deleted_by
      WHERE t.project_id = $1 ORDER BY t.deleted_at DESC, t.batch_id, t.path`,
    [projectId],
  );
  const batches = new Map<string, TrashBatchDto>();
  for (const r of rows) {
    const batch = batches.get(r.batch_id) ?? { id: r.batch_id, via: r.via, deletedBy: r.deleted_by_name, deletedAt: r.deleted_at.toISOString(), overlapped: r.overlapped, items: [] };
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

// Back to the place it was removed from — its folders made again, none of them a link (the agent may
// have put one there: then the file comes back to the top of the project); a taken name gets «(2)»;
// a previous version comes back next to the file that replaced it. Each file on its own, so a failure
// on one leaves the others where they got. Returns the paths the files have now.
export async function restoreFromTrash(db: Db, workspaceRoot: string, project: { id: string; user_id: string }, what: TrashRestore): Promise<string[]> {
  const files = contextRoot(workspaceRoot, project.user_id, project.id);
  const trash = trashDir(workspaceRoot, project.user_id, project.id);
  const { rows } = await db.query<{ id: string }>(
    'ids' in what ? 'SELECT id FROM app.project_trash WHERE project_id = $1 AND id = ANY($2::uuid[]) ORDER BY path' : 'SELECT id FROM app.project_trash WHERE project_id = $1 AND batch_id = $2::uuid ORDER BY path',
    [project.id, 'ids' in what ? what.ids : what.batchId],
  );
  if (rows.length === 0 || ('ids' in what && rows.length !== new Set(what.ids).size)) {
    throw appError('APP_NOT_FOUND', `trash items of project ${project.id} are gone`, { userMessage: 'Этого файла в корзине уже нет. Список обновлён.' });
  }
  const restored: string[] = [];
  for (const { id } of rows) {
    const back = await inTransaction(db, async (c) => {
      const { rows: locked } = await c.query<{ path: string; kind: 'deleted' | 'previous_version' }>('SELECT path, kind FROM app.project_trash WHERE id = $1 FOR UPDATE', [id]);
      const row = locked[0];
      if (!row) return null; // Brought back meanwhile by someone else.
      await c.query('DELETE FROM app.project_trash WHERE id = $1', [id]);
      const source = join(trash, id);
      if (!existsSync(source)) {
        logEvent('warn', 'project_trash_file_missing', { projectId: project.id, trashId: id });
        return null;
      }
      const wanted = row.kind === 'previous_version' ? `${basename(row.path, extname(row.path))}${PREVIOUS_VERSION}${extname(row.path)}` : basename(row.path);
      const place = (prefix: string) => (folder: string) => {
        const name = freeName(folder, wanted);
        renameSync(source, join(folder, name));
        return prefix ? `${prefix}/${name}` : name;
      };
      const prefix = dirname(row.path) === '.' ? '' : dirname(row.path);
      return inFolderOf(files, row.path, true, place(prefix)) ?? inFolderOf(files, wanted, false, place(''));
    });
    if (back) restored.push(back);
  }
  return restored;
}

// Files older than 30 days leave the trash for good: the row first, then the file.
export async function purgeTrash(db: Db, storage: Pick<FileStorage, 'removeFile'>, now = new Date()): Promise<{ files: number; bytes: number }> {
  const { rows } = await db.query<{ id: string; project_id: string; user_id: string; bytes: string }>(
    `DELETE FROM app.project_trash t USING app.projects p WHERE p.id = t.project_id AND t.expires_at <= $1
     RETURNING t.id, t.project_id, p.user_id, t.bytes`,
    [now],
  );
  let bytes = 0;
  for (const r of rows) {
    // From the disk and, with an S3 bucket, from the bucket (spec, section 8.23).
    await storage.removeFile(projectArea(r.project_id, r.user_id), `${TRASH}/${r.id}`);
    bytes += Number(r.bytes);
  }
  if (rows.length > 0) logEvent('info', 'project_trash_purged', { files: rows.length, bytes });
  return { files: rows.length, bytes };
}

function readMeta(file: string): Meta {
  try {
    const meta = JSON.parse(readFileSync(file, 'utf8')) as Partial<Meta>;
    return { userId: typeof meta.userId === 'string' ? meta.userId : null, threadId: typeof meta.threadId === 'string' ? meta.threadId : null };
  } catch (error) {
    // Written halfway when the server stopped: whose answer it was is unknown, its removals are kept.
    logEvent('warn', 'project_snapshot_meta_unreadable', { file, error });
    return { userId: null, threadId: null };
  }
}

// At the start of the server: answers a stopped server left unfinished are settled from their
// snapshots; a folder of a project that is gone is removed; a folder found with another person than
// the project's creator (a removal of an employee stopped halfway) goes to the creator when they have
// none, and is a stray copy otherwise; files of a trash with no row are removed.
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
      const owner = owners.get(projectId);
      if (owner !== userId) {
        const home = owner ? projectRoot(workspaceRoot, owner, projectId) : null;
        if (home && !existsSync(home)) {
          mkdirSync(dirname(home), { recursive: true });
          renameSync(join(projects, projectId), home);
          logEvent('warn', 'project_folder_moved_to_creator', { projectId, from: userId, to: owner });
        } else {
          rmSync(join(projects, projectId), { recursive: true, force: true });
          logEvent('warn', 'project_folder_removed', { projectId, userId });
        }
        continue;
      }
      const snapshots = join(projects, projectId, SNAPSHOTS);
      for (const entry of existsSync(snapshots) ? readdirSync(snapshots) : []) {
        if (!entry.endsWith('.json')) continue;
        const meta = readMeta(join(snapshots, entry));
        await settleSnapshot(db, workspaceRoot, { id: entry.slice(0, -'.json'.length), projectId, ownerId: userId, ...meta });
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

export function startTrashPurge(db: Db, storage: Pick<FileStorage, 'removeFile'>): () => void {
  const purge = () => void purgeTrash(db, storage).catch((error: unknown) => logEvent('error', 'project_trash_purge_failed', { code: 'APP_INTERNAL', error }));
  purge();
  const timer = setInterval(purge, TRASH_PURGE_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
