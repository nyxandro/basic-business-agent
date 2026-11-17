// Working copies of areas (spec, section 8.23): the bucket is where the files are kept, the disk holds a
// copy of an area only while the server works with it — the agent's sandbox and the document programs
// need real files. A copy is made whole into a hidden folder beside and put in place by one rename, then
// the note that it is a full copy is written; changes go back by comparing each file with the size and
// the time of change it was stored with. A folder found without the note (files of the time before the
// bucket, or written while no copy was held) is merged: its files are stored, nothing of the bucket is
// removed. The agent may plant links in its folder, so files are written and read only through
// core/workspace/held-folder.ts.
import { randomUUID } from 'node:crypto';
import { closeSync, constants, createWriteStream, existsSync, fstatSync, futimesSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Db } from '../db/pool.ts';
import { logEvent } from '../server/log.ts';
import { inFolderOf, openRegular, walkRegularFiles } from '../workspace/held-folder.ts';
import { areaDir, areaKey, isWorkingPath, markerPath, type Area } from './areas.ts';
import { forgetStored, rememberStored, storedRows, type StoredRow } from './manifest.ts';
import type { ObjectStore } from './object-store.ts';

// Files moved to or from the bucket at once.
const PARALLEL = 4;

export interface CopyDeps {
  db: Db;
  store: ObjectStore;
  workspaceRoot: string;
}

const objectKey = (area: Area, path: string) => `${areaKey(area)}/${path}`;
const mtimeOf = (ms: number) => Math.trunc(ms);

async function inParallel<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  });
  await Promise.all(lanes);
}

export function hasMarker(workspaceRoot: string, area: Area): boolean {
  try {
    return (JSON.parse(readFileSync(markerPath(workspaceRoot, area), 'utf8')) as { area?: unknown }).area === areaKey(area);
  } catch {
    return false;
  }
}

function writeMarker(workspaceRoot: string, area: Area): void {
  const path = markerPath(workspaceRoot, area);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ area: areaKey(area), at: new Date().toISOString() }));
}

export function removeMarker(workspaceRoot: string, area: Area): void {
  rmSync(markerPath(workspaceRoot, area), { force: true });
}

// One stored file into `root` at its path: its folders made without following links, the bytes written
// under a hidden working name and linked to the real name only when whole and only where nothing is
// (a merge never overwrites a file of the folder, a broken download never leaves half a file), its time
// of change as stored. A row whose object is gone from the bucket (removed there by hand) is dropped:
// nothing else can bring the file back.
async function download(deps: CopyDeps, area: Area, root: string, row: StoredRow): Promise<void> {
  const body = await deps.store.get(objectKey(area, row.path));
  if (!body) {
    logEvent('error', 'storage_object_missing', { code: 'APP_STORAGE_OBJECT_MISSING', area: areaKey(area), path: row.path });
    await forgetStored(deps.db, areaKey(area), row.path);
    return;
  }
  const temp = `.hydrate-${randomUUID()}`;
  const fd = inFolderOf(root, row.path, true, (folder) => openSync(join(folder, temp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644));
  if (fd === null) {
    // A folder of the path is a link or a file in the folder now (merge): what is there wins.
    body.destroy();
    logEvent('warn', 'storage_file_blocked', { area: areaKey(area), path: row.path });
    return;
  }
  try {
    await pipeline(body, createWriteStream('', { fd, autoClose: false }));
    const seconds = row.mtimeMs / 1000;
    futimesSync(fd, seconds, seconds);
  } finally {
    closeSync(fd);
  }
  inFolderOf(root, row.path, false, (folder, name) => {
    try {
      linkSync(join(folder, temp), join(folder, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      rmSync(join(folder, temp), { force: true });
    }
  });
}

// The area as the bucket holds it, put in place whole.
export async function makeCopy(deps: CopyDeps, area: Area): Promise<void> {
  const dir = areaDir(deps.workspaceRoot, area);
  const rows = await storedRows(deps.db, areaKey(area));
  const temp = join(dirname(dir), `.hydrate-${randomUUID()}`);
  mkdirSync(temp, { recursive: true });
  try {
    await inParallel(rows, (row) => download(deps, area, temp, row));
    renameSync(temp, dir);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  writeMarker(deps.workspaceRoot, area);
  logEvent('info', 'storage_copy_made', { area: areaKey(area), files: rows.length });
}

// The files of the bucket the folder lacks, written into it (a merge never overwrites a file there).
async function fillMissing(deps: CopyDeps, area: Area): Promise<number> {
  const dir = areaDir(deps.workspaceRoot, area);
  const present = new Set<string>();
  walkRegularFiles(dir, (file) => void present.add(file.rel), true);
  const missing = (await storedRows(deps.db, areaKey(area))).filter((row) => !present.has(row.path));
  await inParallel(missing, (row) => download(deps, area, dir, row));
  return missing.length;
}

// A folder without the note becomes a working copy: its files stored, the bucket's other files brought.
export async function adopt(deps: CopyDeps, area: Area): Promise<void> {
  const stored = await storeChanges(deps, area, false);
  const brought = await fillMissing(deps, area);
  writeMarker(deps.workspaceRoot, area);
  logEvent('info', 'storage_folder_adopted', { area: areaKey(area), stored, brought });
}

// What changed in the copy goes to the bucket; with `removeMissing` (a full copy) a file gone from the
// copy is removed from the bucket too. Returns the number of files stored.
export async function storeChanges(deps: CopyDeps, area: Area, removeMissing: boolean): Promise<number> {
  const dir = areaDir(deps.workspaceRoot, area);
  if (!existsSync(dir)) return 0;
  const key = areaKey(area);
  const rows = new Map((await storedRows(deps.db, key)).map((r) => [r.path, r]));
  const seen = new Set<string>();
  const changed: string[] = [];
  walkRegularFiles(
    dir,
    (file) => {
      if (isWorkingPath(file.rel)) return;
      seen.add(file.rel);
      const row = rows.get(file.rel);
      if (!row || row.bytes !== file.size || row.mtimeMs !== mtimeOf(file.modifiedMs)) changed.push(file.rel);
    },
    true,
  );
  let stored = 0;
  await inParallel(changed, async (path) => {
    const fd = inFolderOf(dir, path, false, (folder, name) => openRegular(join(folder, name)));
    if (fd === null) return; // Gone meanwhile: the next pass sees it missing.
    const stat = fstatSync(fd);
    await deps.store.putFile(objectKey(area, path), fd);
    await rememberStored(deps.db, key, { path, bytes: stat.size, mtimeMs: mtimeOf(stat.mtimeMs) });
    stored++;
  });
  if (removeMissing) {
    const gone = [...rows.keys()].filter((path) => !seen.has(path));
    await inParallel(gone, async (path) => {
      await forgetStored(deps.db, key, path);
      await deps.store.remove(objectKey(area, path));
    });
  }
  return stored;
}

// The copy leaves the disk: moved aside by one rename, then removed.
export function removeCopy(workspaceRoot: string, area: Area): void {
  const dir = areaDir(workspaceRoot, area);
  if (existsSync(dir)) {
    const aside = join(dirname(dir), `.evict-${randomUUID()}`);
    renameSync(dir, aside);
    rmSync(aside, { recursive: true, force: true });
  }
  removeMarker(workspaceRoot, area);
}

// Moving back onto the disk: the files of the area the disk lacks are brought, then the bucket forgets it.
export async function bringBack(deps: CopyDeps, area: Area): Promise<number> {
  const dir = areaDir(deps.workspaceRoot, area);
  if (existsSync(dir)) await fillMissing(deps, area);
  else await makeCopy(deps, area);
  const key = areaKey(area);
  const rows = await storedRows(deps.db, key);
  await inParallel(rows, async (row) => {
    await forgetStored(deps.db, key, row.path);
    await deps.store.remove(objectKey(area, row.path));
  });
  removeMarker(deps.workspaceRoot, area);
  return rows.length;
}

// The area is gone for good (a project removed, an employee deleted): its objects and rows go too.
export async function dropStored(deps: CopyDeps, area: Area): Promise<void> {
  const key = areaKey(area);
  const rows = await storedRows(deps.db, key);
  await inParallel(rows, async (row) => {
    await forgetStored(deps.db, key, row.path);
    await deps.store.remove(objectKey(area, row.path));
  });
}

export async function removeStoredFile(deps: CopyDeps, area: Area, path: string): Promise<void> {
  await forgetStored(deps.db, areaKey(area), path);
  await deps.store.remove(objectKey(area, path));
}
