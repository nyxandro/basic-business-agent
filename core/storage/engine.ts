// Where the files of the workspace live (spec, section 8.23). By default — the server's disk, as before.
// With an S3 bucket connected the files are kept only there: an area (a person's conversations outside
// projects, or a project) gets a working copy on the disk while the server works with it — a run of the
// agent, an upload, a download — and the copy goes 10 minutes after the last use. Every place that
// touches files of an area holds it first (`hold`); while held, no copy is made, merged or removed under
// it. One server process serves the installation, so the holds are counted in memory.
import { createReadStream, existsSync, rmSync, statSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { join, relative } from 'node:path';
import type { StorageConnectInput, StorageKeysInput, StorageStatus } from '@bba/contracts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/pool.ts';
import { AppError, isAppError } from '../errors/app-error.ts';
import { logEvent } from '../server/log.ts';
import { walkRegularFiles } from '../workspace/held-folder.ts';
import { existingInside, isDraftPath, isFileInside, listFiles, MAX_LISTED_FILES, openFileInside, removeFileInside, resolveInside } from '../workspace/layout.ts';
import { areaDir, areaKey, filesPrefix, localAreas, parseAreaKey, projectArea, userArea, type Area } from './areas.ts';
import { adopt, bringBack, dropStored, hasMarker, makeCopy, removeCopy, removeStoredFile, storeChanges, unreadableNames, type CopyDeps } from './copies.ts';
import { storedAreas, storedRows, storedTotals } from './manifest.ts';
import { checkObjectStore, createObjectStore, type ObjectStore, type S3Config } from './object-store.ts';
import { loadStorageSettings, recordStorageError, saveLocalSettings, saveS3Settings, setStorageState, type StorageSettings } from './settings.ts';

// A copy nobody used for this long leaves the disk.
export const KEEP_COPY_MS = 10 * 60 * 1000;
// How often copies are checked: stored, removed, moved.
export const SWEEP_EVERY_MS = 60 * 1000;

export type Release = () => Promise<void>;

export interface StoredFile {
  // From the person's files folder of the area, with «/».
  rel: string;
  bytes: number;
  modifiedMs: number;
}

export interface FileStorage {
  readonly workspaceRoot: string;
  // The area's files are on the disk until `release`: `write` stores what changed when released.
  hold(area: Area, how: 'read' | 'write'): Promise<Release>;
  // Work on the area's folder itself (moving a project to another person): nothing else touches it meanwhile.
  exclusive<T>(area: Area, work: () => T | Promise<T>): Promise<T>;
  // Work on the area's folder that must not run under an answer holding it (a project given to another
  // person): refused with APP_STORAGE_BUSY while anything holds the area.
  exclusiveIdle<T>(area: Area, work: () => T | Promise<T>): Promise<T>;
  // A file of the area (`rel` from the area: «files/…», «trash/…» of a project) without making a copy: from
  // the copy when there is one, otherwise straight from the bucket. Null when there is no such file.
  openFile(area: Area, rel: string): Promise<{ stream: Readable; bytes: number } | null>;
  exists(area: Area, rel: string): Promise<boolean>;
  // A file's size and time of change (whole milliseconds, as the list of the bucket keeps them) without
  // reading it: the viewer looks a ready PDF up by them (spec, section 8.27). Null when there is no file.
  stat(area: Area, rel: string): Promise<{ bytes: number; modifiedMs: number } | null>;
  // The person's files of the area without making a copy (search, counts): from the copy when there is
  // one, otherwise from the list of the bucket. `visit` returning false stops.
  walkFiles(area: Area, visit: (file: StoredFile) => boolean | void): Promise<void>;
  // «Файлы проекта» and the files a project shows: as listFiles of core/workspace/layout.ts gives them.
  list(area: Area): Promise<{ path: string; bytes: number }[]>;
  // A file of the area removed for good (the trash empties itself).
  removeFile(area: Area, rel: string): Promise<void>;
  // The agent's drafts (spec, section 8.33) not changed since `before` (ms), removed for good in every area, from the
  // disk and the bucket. An area held now is left to the next time: an answer may be using an old script.
  removeStaleDrafts(before: number): Promise<{ files: number; bytes: number }>;
  // The area removed for good with all its files.
  drop(area: Area): Promise<void>;
  status(): Promise<StorageStatus>;
  connect(input: StorageConnectInput): Promise<void>;
  updateKeys(input: StorageKeysInput): Promise<void>;
  disconnect(): Promise<void>;
  // Loads the settings and starts the regular pass; `stop` ends it.
  start(): Promise<void>;
  stop(): void;
  // One pass: copies stored and removed, folders moved. Started by the timer; tests call it directly.
  sweep(): Promise<void>;
}

export interface StorageDeps {
  db: Db;
  box: SecretBox;
  workspaceRoot: string;
  // KEEP_COPY_MS in an installation; tests shorten it.
  keepCopyMs: number;
  // Makes the client of a bucket: tests may point it at their fake S3.
  connectStore?: (config: S3Config) => ObjectStore;
}

interface AreaState {
  holders: number;
  lastUsed: number;
  chain: Promise<unknown>;
}

function busy(): AppError {
  return new AppError({
    code: 'APP_STORAGE_BUSY',
    message: 'files are being moved between the disk and the bucket',
    userMessage: 'Файлы ещё переносятся. Дождитесь окончания переноса — ход виден в этом разделе.',
    status: 409,
  });
}

function namesUnsupported(area: string, files: number): AppError {
  return new AppError({
    code: 'APP_STORAGE_NAME_UNSUPPORTED',
    message: `${files} names in ${area} are not UTF-8`,
    userMessage: 'В папке есть файлы с именами в старой кодировке (например, из архива Windows) — их не сохранить в хранилище, поэтому папка остаётся на диске сервера.',
    nextStep: 'Попросите агента переименовать такие файлы.',
    status: 500,
  });
}

export function createFileStorage(deps: StorageDeps): FileStorage {
  const { db, workspaceRoot } = deps;
  const connectStore = deps.connectStore ?? createObjectStore;
  let settings: StorageSettings = { mode: 'local', state: 'active', lastError: null };
  let store: ObjectStore | null = null;
  let timer: NodeJS.Timeout | null = null;
  let sweeping: Promise<void> | null = null;
  const areas = new Map<string, AreaState>();

  const remote = () => settings.mode === 's3' && store !== null;
  const copyDeps = (): CopyDeps => ({ db, store: store!, workspaceRoot });
  const stateOf = (area: Area): AreaState => {
    const key = areaKey(area);
    let state = areas.get(key);
    if (!state) {
      state = { holders: 0, lastUsed: 0, chain: Promise.resolve() };
      areas.set(key, state);
    }
    return state;
  };

  function exclusive<T>(area: Area, work: () => T | Promise<T>): Promise<T> {
    const state = stateOf(area);
    const next = state.chain.then(work, work);
    state.chain = next.catch(() => undefined);
    return next;
  }

  // The area's files are on the disk: a copy made, or a folder without the note merged. While files go
  // back to the disk (`to_local`) a folder that is there is already the person's.
  async function ensureCopy(area: Area): Promise<void> {
    if (!existsSync(areaDir(workspaceRoot, area))) return makeCopy(copyDeps(), area);
    if (hasMarker(workspaceRoot, area) || settings.state === 'to_local') return;
    await adopt(copyDeps(), area);
  }

  async function storeHeld(area: Area): Promise<void> {
    if (settings.state === 'to_local' && !hasMarker(workspaceRoot, area)) return;
    await storeChanges(copyDeps(), area, hasMarker(workspaceRoot, area));
  }

  function failed(event: string, area: Area | null, error: unknown): void {
    const code = isAppError(error) ? error.code : 'APP_STORAGE_SYNC_FAILED';
    logEvent('error', event, { code, area: area ? areaKey(area) : null, error });
    settings = { ...settings, lastError: { code, at: new Date() } };
    void recordStorageError(db, code).catch((e: unknown) => logEvent('error', 'storage_error_record_failed', { error: e }));
  }

  async function hold(area: Area, how: 'read' | 'write'): Promise<Release> {
    const state = stateOf(area);
    state.holders++;
    try {
      await exclusive(area, () => (remote() ? ensureCopy(area) : undefined));
    } catch (error) {
      state.holders--;
      state.lastUsed = Date.now();
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        // A failure keeps the copy on the disk: the next pass stores it.
        if (how === 'write' && remote()) await exclusive(area, () => storeHeld(area));
      } catch (error) {
        failed('storage_store_failed', area, error);
      } finally {
        state.holders--;
        state.lastUsed = Date.now();
      }
    };
  }

  // A copy nobody holds: stored, then removed from the disk if still nobody holds it.
  async function evict(area: Area): Promise<void> {
    const state = stateOf(area);
    await exclusive(area, async () => {
      if (state.holders > 0) return;
      if (!hasMarker(workspaceRoot, area)) await adopt(copyDeps(), area);
      else await storeChanges(copyDeps(), area, true);
      if (state.holders > 0) return;
      const unreadable = unreadableNames(areaDir(workspaceRoot, area));
      if (unreadable > 0) throw namesUnsupported(areaKey(area), unreadable);
      removeCopy(workspaceRoot, area);
      logEvent('info', 'storage_copy_removed', { area: areaKey(area) });
    });
  }

  async function areaOfKey(key: string): Promise<Area | null> {
    const parsed = parseAreaKey(key);
    if (!parsed) return null;
    if (parsed.kind === 'user') return userArea(parsed.userId);
    const { rows } = await db.query<{ user_id: string }>('SELECT user_id FROM app.projects WHERE id = $1', [parsed.projectId]);
    return rows[0] ? projectArea(parsed.projectId, rows[0].user_id) : null;
  }

  async function sweepOnce(): Promise<void> {
    if (!remote()) return;
    let errors = 0;
    if (settings.state === 'to_local') {
      for (const key of await storedAreas(db)) {
        const area = await areaOfKey(key);
        try {
          if (!area) {
            // A project removed while its files were stored: nothing to bring back.
            const parsed = parseAreaKey(key);
            if (parsed?.kind === 'project') await dropStored(copyDeps(), projectArea(parsed.projectId, '_'));
            continue;
          }
          const files = await exclusive(area, () => bringBack(copyDeps(), area));
          logEvent('info', 'storage_area_brought_back', { area: key, files });
        } catch (error) {
          errors++;
          failed('storage_bring_back_failed', area, error);
        }
      }
      if (errors === 0 && (await storedAreas(db)).length === 0) {
        await saveLocalSettings(db);
        store?.close();
        store = null;
        settings = { mode: 'local', state: 'active', lastError: null };
        logEvent('info', 'storage_moved_to_disk', {});
      }
      return;
    }
    const now = Date.now();
    // A project's folder found with someone other than its creator is a leftover of a move stopped
    // halfway: the start of the server sorts it out (recoverProjectFolders), the pass leaves it alone.
    const { rows: owners } = await db.query<{ id: string; user_id: string }>('SELECT id, user_id FROM app.projects');
    const ownerOf = new Map(owners.map((r) => [r.id, r.user_id]));
    for (const area of localAreas(workspaceRoot)) {
      const state = stateOf(area);
      if (state.holders > 0) continue;
      if (area.kind === 'project' && ownerOf.get(area.projectId) !== area.ownerId) {
        logEvent('warn', 'storage_folder_not_of_owner', { area: areaKey(area), folderOf: area.ownerId });
        continue;
      }
      if (hasMarker(workspaceRoot, area) && now - state.lastUsed < deps.keepCopyMs) continue;
      try {
        await evict(area);
      } catch (error) {
        errors++;
        failed('storage_sweep_failed', area, error);
      }
    }
    if (settings.state === 'to_s3' && errors === 0 && localAreas(workspaceRoot).every((a) => hasMarker(workspaceRoot, a))) {
      await setStorageState(db, 'active');
      settings = { ...settings, state: 'active' };
      logEvent('info', 'storage_moved_to_bucket', {});
    }
    if (errors === 0 && settings.lastError) {
      await recordStorageError(db, null);
      settings = { ...settings, lastError: null };
    }
  }

  // One pass at a time: the timer and a change of settings may both ask for one.
  function sweep(): Promise<void> {
    sweeping ??= sweepOnce()
      .catch((error: unknown) => failed('storage_sweep_failed', null, error))
      .finally(() => {
        sweeping = null;
      });
    return sweeping;
  }

  async function reload(): Promise<void> {
    settings = await loadStorageSettings(db, deps.box);
    store?.close();
    store = settings.mode === 's3' ? connectStore(settings.config) : null;
  }

  return {
    workspaceRoot,
    hold,
    exclusive,

    async walkFiles(area, visit) {
      const dir = areaDir(workspaceRoot, area);
      const prefix = filesPrefix(area);
      if (!remote() || existsSync(dir)) {
        walkRegularFiles(join(dir, prefix), (f) => visit({ rel: f.rel, bytes: f.size, modifiedMs: f.modifiedMs }));
        return;
      }
      for (const row of await storedRows(db, areaKey(area), prefix)) {
        const rel = row.path.slice(prefix.length);
        // Hidden entries are working files, as in the walk of a folder.
        if (rel.split('/').some((part) => part.startsWith('.'))) continue;
        if (visit({ rel, bytes: row.bytes, modifiedMs: row.mtimeMs }) === false) return;
      }
    },

    async list(area) {
      const dir = areaDir(workspaceRoot, area);
      const prefix = filesPrefix(area);
      if (!remote() || existsSync(dir)) return listFiles(join(dir, prefix));
      const out: { path: string; bytes: number }[] = [];
      for (const row of await storedRows(db, areaKey(area), prefix)) {
        const rel = row.path.slice(prefix.length);
        if (rel.split('/').some((part) => part.startsWith('.'))) continue;
        out.push({ path: rel, bytes: row.bytes });
      }
      return out.sort((a, b) => a.path.localeCompare(b.path, 'ru')).slice(0, MAX_LISTED_FILES);
    },

    exclusiveIdle(area, work) {
      return exclusive(area, () => {
        if (stateOf(area).holders > 0) {
          throw new AppError({ code: 'APP_STORAGE_BUSY', message: `${areaKey(area)} is held by an answer`, userMessage: 'С файлами сейчас работает агент. Повторите через минуту.', status: 409 });
        }
        return work();
      });
    },

    openFile(area, rel) {
      return exclusive(area, async () => {
        const dir = areaDir(workspaceRoot, area);
        if (!remote() || existsSync(dir)) {
          const file = openFileInside(dir, rel);
          return file ? { stream: createReadStream('', { fd: file.fd, autoClose: true }), bytes: file.size } : null;
        }
        const path = relative(dir, resolveInside(dir, rel));
        const row = (await storedRows(db, areaKey(area), path)).find((r) => r.path === path);
        if (!row) return null;
        const stream = await store!.get(`${areaKey(area)}/${path}`);
        return stream ? { stream, bytes: row.bytes } : null;
      });
    },

    exists(area, rel) {
      return exclusive(area, async () => {
        const dir = areaDir(workspaceRoot, area);
        if (!remote() || existsSync(dir)) return isFileInside(dir, rel);
        const path = relative(dir, resolveInside(dir, rel));
        return (await storedRows(db, areaKey(area), path)).some((r) => r.path === path);
      });
    },

    stat(area, rel) {
      return exclusive(area, async () => {
        const dir = areaDir(workspaceRoot, area);
        if (!remote() || existsSync(dir)) {
          const real = existingInside(dir, rel);
          if (!real) return null;
          const file = statSync(real);
          return file.isFile() ? { bytes: file.size, modifiedMs: Math.trunc(file.mtimeMs) } : null;
        }
        const path = relative(dir, resolveInside(dir, rel));
        const row = (await storedRows(db, areaKey(area), path)).find((r) => r.path === path);
        return row ? { bytes: row.bytes, modifiedMs: row.mtimeMs } : null;
      });
    },

    removeFile(area, rel) {
      return exclusive(area, async () => {
        const dir = areaDir(workspaceRoot, area);
        if (existsSync(dir)) rmSync(resolveInside(dir, rel), { force: true });
        if (remote()) await removeStoredFile(copyDeps(), area, rel);
      });
    },

    async removeStaleDrafts(before) {
      const areas = new Map(localAreas(workspaceRoot).map((a) => [areaKey(a), a]));
      if (remote()) {
        for (const key of await storedAreas(db)) {
          const area = areas.has(key) ? null : await areaOfKey(key);
          if (area) areas.set(key, area);
        }
      }
      const removed = { files: 0, bytes: 0 };
      for (const area of areas.values()) {
        if (stateOf(area).holders > 0) continue;
        await exclusive(area, async () => {
          if (stateOf(area).holders > 0) return;
          const dir = areaDir(workspaceRoot, area);
          const prefix = filesPrefix(area);
          // A draft is old when neither its copy on the disk nor the bucket has it changed since `before`.
          const drafts = new Map<string, { bytes: number; modifiedMs: number }>();
          if (existsSync(dir)) {
            walkRegularFiles(
              join(dir, prefix),
              (f) => {
                if (isDraftPath(f.rel)) drafts.set(prefix + f.rel, { bytes: f.size, modifiedMs: f.modifiedMs });
              },
              true,
            );
          }
          if (remote()) {
            for (const row of await storedRows(db, areaKey(area), prefix)) {
              if (!isDraftPath(row.path.slice(prefix.length))) continue;
              const disk = drafts.get(row.path);
              drafts.set(row.path, { bytes: disk?.bytes ?? row.bytes, modifiedMs: Math.max(disk?.modifiedMs ?? 0, row.mtimeMs) });
            }
          }
          for (const [rel, draft] of drafts) {
            if (draft.modifiedMs >= before) continue;
            // Removed in the folder opened and checked: the agent may have made a folder of the path a link meanwhile
            // (a process of it left running) — such a draft stays, and the others are removed.
            try {
              if (existsSync(dir)) removeFileInside(dir, rel);
            } catch (error) {
              if (!isAppError(error) || error.code !== 'APP_VALIDATION_FAILED') throw error;
              logEvent('warn', 'draft_behind_link_kept', { area: areaKey(area), code: error.code });
              continue;
            }
            if (remote()) await removeStoredFile(copyDeps(), area, rel);
            removed.files += 1;
            removed.bytes += draft.bytes;
          }
        });
      }
      return removed;
    },

    drop(area) {
      return exclusive(area, async () => {
        rmSync(areaDir(workspaceRoot, area), { recursive: true, force: true });
        removeCopy(workspaceRoot, area);
        if (remote()) await dropStored(copyDeps(), area);
      });
    },

    async status() {
      const local = localAreas(workspaceRoot);
      const waiting =
        settings.mode === 's3' && settings.state === 'to_s3'
          ? local.filter((a) => !hasMarker(workspaceRoot, a)).length
          : settings.mode === 's3' && settings.state === 'to_local'
            ? (await storedAreas(db)).length
            : 0;
      return {
        mode: settings.mode,
        state: settings.state,
        bucket:
          settings.mode === 's3'
            ? { provider: settings.provider, endpoint: settings.config.endpoint, region: settings.config.region, bucket: settings.config.bucket, prefix: settings.config.prefix, pathStyle: settings.config.pathStyle, connectedAt: settings.connectedAt.toISOString() }
            : null,
        stored: settings.mode === 's3' ? await storedTotals(db) : { files: 0, bytes: 0 },
        local: { folders: local.length, waiting },
        lastError: settings.lastError ? { code: settings.lastError.code, at: settings.lastError.at.toISOString() } : null,
      };
    },

    async connect(input) {
      if (settings.mode !== 'local') throw new AppError({ code: 'APP_STORAGE_ALREADY_CONNECTED', message: 'a bucket is connected already', userMessage: 'Хранилище уже подключено. Чтобы сменить бакет, сначала отключите текущее — файлы вернутся на сервер.', status: 409 });
      const prefix = input.prefix && !input.prefix.endsWith('/') ? `${input.prefix}/` : input.prefix;
      const config: S3Config = { endpoint: input.endpoint, region: input.region, bucket: input.bucket, prefix, pathStyle: input.pathStyle, accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey };
      const candidate = connectStore(config);
      try {
        await checkObjectStore(candidate);
        // Another installation's files there would mix with ours.
        const present = (await candidate.list('')).filter((o) => !o.key.startsWith('.bba-check/'));
        if (present.length > 0) {
          throw new AppError({
            code: 'APP_STORAGE_NOT_EMPTY',
            message: `the bucket folder holds ${present.length} objects`,
            userMessage: `В этой папке бакета уже есть файлы (${present.length}). Чтобы не смешать их с файлами установки, укажите пустой бакет или другую папку.`,
            status: 409,
          });
        }
      } finally {
        candidate.close();
      }
      await saveS3Settings(db, deps.box, { provider: input.provider, config, state: 'to_s3' });
      await reload();
      logEvent('info', 'storage_connected', { provider: input.provider, bucket: input.bucket });
      void sweep();
    },

    async updateKeys(input) {
      if (settings.mode !== 's3') throw new AppError({ code: 'APP_STORAGE_NOT_CONNECTED', message: 'no bucket to change keys of', userMessage: 'Хранилище не подключено.', status: 409 });
      const config: S3Config = { ...settings.config, accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey };
      const candidate = connectStore(config);
      try {
        await checkObjectStore(candidate);
      } finally {
        candidate.close();
      }
      await saveS3Settings(db, deps.box, { provider: settings.provider, config, state: settings.state });
      await reload();
      logEvent('info', 'storage_keys_changed', { bucket: config.bucket });
      void sweep();
    },

    async disconnect() {
      if (settings.mode !== 's3') throw new AppError({ code: 'APP_STORAGE_NOT_CONNECTED', message: 'no bucket to disconnect', userMessage: 'Хранилище не подключено.', status: 409 });
      if (settings.state === 'to_local') throw busy();
      await setStorageState(db, 'to_local');
      settings = { ...settings, state: 'to_local' };
      logEvent('info', 'storage_disconnect_started', {});
      void sweep();
    },

    async start() {
      await reload();
      timer = setInterval(() => void sweep(), SWEEP_EVERY_MS);
      timer.unref();
      if (remote()) void sweep();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      store?.close();
    },

    sweep,
  };
}
