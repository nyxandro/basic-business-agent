// The file storage (spec, section 8.23): with a bucket connected the files live only there; the disk holds
// a working copy of an area while it is held and 10 minutes after; the copies are stored back by what
// changed; files of the time before the bucket are moved into it, and back when it is disconnected.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSecretBox } from '../crypto/secret-box.ts';
import { migrate } from '../db/migrate.ts';
import { createPool, type Db } from '../db/pool.ts';
import { createTestDatabase, type TestDatabase } from '../db/test-database.ts';
import { TEST_ENCRYPTION_KEYS } from '../server/test-app.ts';
import { areaDir, projectArea, userArea } from './areas.ts';
import { createFileStorage, type FileStorage } from './engine.ts';
import { startFakeS3, type FakeS3 } from './fake-s3.ts';

let database: TestDatabase;
let db: Db;
let s3: FakeS3;
let root: string;
let storage: FileStorage;

const box = createSecretBox(TEST_ENCRYPTION_KEYS);
const olga = userArea('olga');
const tender = projectArea('0b9d1c62-6f4a-4c55-9d43-1d2b6c0e6a11', 'olga');

function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');
const bucketKeys = () => [...s3.objects.keys()].filter((k) => !k.includes('.bba-check')).sort();
const connectInput = (over: Partial<Parameters<FileStorage['connect']>[0]> = {}) => ({
  provider: 'other' as const,
  endpoint: s3.endpoint,
  region: 'ru-1',
  bucket: s3.bucket,
  prefix: 'bba/',
  pathStyle: true,
  accessKeyId: s3.accessKeyId,
  secretAccessKey: 'secret',
  ...over,
});

async function connected(): Promise<void> {
  await storage.connect(connectInput());
  await storage.sweep();
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.url);
  db = createPool(database.url);
  // The project of the tests is known to the database with its creator, as every project is.
  await db.query(`INSERT INTO app."user" ("id", "name", "email", "emailVerified") VALUES ('olga', 'Ольга', 'olga@example.com', true)`);
  await db.query("INSERT INTO app.projects (id, user_id, name, access) VALUES ('0b9d1c62-6f4a-4c55-9d43-1d2b6c0e6a11', 'olga', 'Тендер', 'private')");
});
afterAll(async () => {
  await db.end();
  await database.drop();
});
beforeEach(async () => {
  s3 = await startFakeS3();
  root = mkdtempSync(join(tmpdir(), 'bba-storage-'));
  await db.query('DELETE FROM app.storage_objects');
  await db.query("UPDATE app.storage_settings SET mode = 'local', state = 'active', provider = NULL, endpoint = NULL, region = NULL, bucket = NULL, prefix = '', path_style = NULL, ciphertext = NULL, iv = NULL, key_version = NULL, connected_at = NULL, last_error_code = NULL, last_error_at = NULL");
  storage = createFileStorage({ db, box, workspaceRoot: root, keepCopyMs: 0 });
  await storage.start();
});
afterEach(async () => {
  storage.stop();
  await s3.close();
  rmSync(root, { recursive: true, force: true });
});

describe('connecting a bucket', () => {
  it('refuses a wrong key, a wrong bucket and a folder with files of someone else, and stores nothing', async () => {
    await expect(storage.connect(connectInput({ accessKeyId: 'wrong' }))).rejects.toMatchObject({ code: 'APP_STORAGE_ACCESS_DENIED' });
    await expect(storage.connect(connectInput({ bucket: 'other-bucket' }))).rejects.toMatchObject({ code: 'APP_STORAGE_BUCKET_NOT_FOUND' });
    s3.objects.set('bba/users/x/files/чужой.txt', Buffer.from('x'));
    await expect(storage.connect(connectInput())).rejects.toMatchObject({ code: 'APP_STORAGE_NOT_EMPTY' });
    // Another folder of the same bucket is fine.
    await storage.connect(connectInput({ prefix: 'ours' }));
    expect((await storage.status()).bucket).toMatchObject({ prefix: 'ours/', bucket: s3.bucket });
  });

  it('moves the files of the disk into the bucket and leaves the disk without them', async () => {
    put(areaDir(root, olga), 'договор.pdf', 'pdf');
    put(areaDir(root, tender), 'files/сметы/смета.xlsx', 'xlsx');
    put(areaDir(root, tender), 'trash/7c8f6c1e-0000-4000-8000-000000000001', 'old');
    put(areaDir(root, tender), '.snapshots/s1/смета.xlsx', 'snapshot');
    await storage.connect(connectInput());
    expect((await storage.status()).state).toBe('to_s3');
    await storage.sweep();
    expect(bucketKeys()).toEqual([
      'bba/projects/0b9d1c62-6f4a-4c55-9d43-1d2b6c0e6a11/files/сметы/смета.xlsx',
      'bba/projects/0b9d1c62-6f4a-4c55-9d43-1d2b6c0e6a11/trash/7c8f6c1e-0000-4000-8000-000000000001',
      'bba/users/olga/files/договор.pdf',
    ]);
    expect(existsSync(areaDir(root, olga))).toBe(false);
    expect(existsSync(areaDir(root, tender))).toBe(false);
    const status = await storage.status();
    expect(status).toMatchObject({ mode: 's3', state: 'active', stored: { files: 3, bytes: 10 }, local: { folders: 0, waiting: 0 }, lastError: null });
  });

  it('keeps the keys only encrypted', async () => {
    await storage.connect(connectInput({ secretAccessKey: 'очень-секретно' }));
    const { rows } = await db.query<{ ciphertext: Buffer }>('SELECT ciphertext FROM app.storage_settings');
    expect(rows[0]!.ciphertext.toString('utf8')).not.toContain('очень-секретно');
    expect(JSON.stringify(await storage.status())).not.toContain('очень-секретно');
  });
});

describe('a working copy', () => {
  beforeEach(connected);

  it('comes back for a hold, stores what changed when released and leaves the disk after the quiet time', async () => {
    put(areaDir(root, olga), 'a.txt', 'one');
    const first = await storage.hold(olga, 'write');
    await first();
    await storage.sweep();
    expect(existsSync(areaDir(root, olga))).toBe(false);

    const release = await storage.hold(olga, 'write');
    const dir = areaDir(root, olga);
    expect(read(dir, 'a.txt')).toBe('one');
    put(dir, 'отчёт/b.docx', 'two');
    writeFileSync(join(dir, 'a.txt'), 'one more');
    put(dir, '.renders/page-1.png', 'png');
    // A file of the person's computer brought for an answer (spec, section 8.25) is not stored either.
    put(dir, '.computer/Договоры/договор.docx', 'docx');
    // Held: the pass leaves it alone.
    await storage.sweep();
    expect(existsSync(dir)).toBe(true);
    await release();
    expect(s3.objects.get('bba/users/olga/files/a.txt')?.toString()).toBe('one more');
    expect(s3.objects.get('bba/users/olga/files/отчёт/b.docx')?.toString()).toBe('two');
    expect(bucketKeys().some((k) => k.includes('.renders') || k.includes('.computer'))).toBe(false);
    await storage.sweep();
    expect(existsSync(dir)).toBe(false);
  });

  it('removes from the bucket a file removed in the copy', async () => {
    put(areaDir(root, olga), 'a.txt', 'one');
    await (await storage.hold(olga, 'write'))();
    const release = await storage.hold(olga, 'write');
    unlinkSync(join(areaDir(root, olga), 'a.txt'));
    await release();
    expect(bucketKeys()).toEqual([]);
  });

  it('a read hold stores nothing; a file is listed from the bucket while there is no copy', async () => {
    const release = await storage.hold(tender, 'write');
    put(areaDir(root, tender), 'files/смета.xlsx', '12345');
    put(areaDir(root, tender), 'trash/7c8f6c1e-0000-4000-8000-000000000002', 'x');
    await release();
    await storage.sweep();
    const listed: string[] = [];
    await storage.walkFiles(tender, (f) => void listed.push(`${f.rel}:${f.bytes}`));
    expect(listed).toEqual(['смета.xlsx:5']);
    const reading = await storage.hold(tender, 'read');
    writeFileSync(join(areaDir(root, tender), 'files/смета.xlsx'), 'changed by nobody who stores');
    await reading();
    expect(s3.objects.get('bba/projects/0b9d1c62-6f4a-4c55-9d43-1d2b6c0e6a11/files/смета.xlsx')?.toString()).toBe('12345');
  });

  it('keeps its time of change, so an untouched file is not stored again', async () => {
    put(areaDir(root, olga), 'a.txt', 'one');
    utimesSync(join(areaDir(root, olga), 'a.txt'), 1_700_000_000.123, 1_700_000_000.123);
    await (await storage.hold(olga, 'write'))();
    await storage.sweep();
    const puts = s3.calls.PUT ?? 0;
    await (await storage.hold(olga, 'write'))();
    expect(s3.calls.PUT ?? 0).toBe(puts);
  });

  it('a folder written without a hold is merged into the bucket, never emptying it', async () => {
    put(areaDir(root, olga), 'a.txt', 'one');
    await (await storage.hold(olga, 'write'))();
    await storage.sweep();
    // Someone wrote into the person's folder while it had no copy.
    put(areaDir(root, olga), 'b.txt', 'two');
    await storage.sweep();
    expect(bucketKeys()).toEqual(['bba/users/olga/files/a.txt', 'bba/users/olga/files/b.txt']);
    const release = await storage.hold(olga, 'read');
    expect(read(areaDir(root, olga), 'a.txt')).toBe('one');
    await release();
  });

  it('a link the agent planted is neither followed when stored nor written through when the copy comes back', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'bba-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'server secret');
    put(areaDir(root, olga), 'папка/a.txt', 'one');
    await (await storage.hold(olga, 'write'))();
    const release = await storage.hold(olga, 'write');
    symlinkSync(join(outside, 'secret.txt'), join(areaDir(root, olga), 'украдено.txt'));
    await release();
    expect(bucketKeys().some((k) => k.includes('украдено'))).toBe(false);
    // The folder of a stored file swapped for a link while there was no copy: the merge brings nothing through it.
    await storage.sweep();
    mkdirSync(areaDir(root, olga), { recursive: true });
    symlinkSync(outside, join(areaDir(root, olga), 'папка'));
    const release2 = await storage.hold(olga, 'read');
    await release2();
    expect(existsSync(join(outside, 'a.txt'))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('removes one file and a whole area for good', async () => {
    const release = await storage.hold(tender, 'write');
    put(areaDir(root, tender), 'files/a.txt', 'a');
    put(areaDir(root, tender), 'trash/7c8f6c1e-0000-4000-8000-000000000003', 'b');
    await release();
    await storage.sweep();
    await storage.removeFile(tender, 'trash/7c8f6c1e-0000-4000-8000-000000000003');
    expect(bucketKeys()).toEqual(['bba/projects/0b9d1c62-6f4a-4c55-9d43-1d2b6c0e6a11/files/a.txt']);
    await storage.drop(tender);
    expect(bucketKeys()).toEqual([]);
    expect((await storage.status()).stored.files).toBe(0);
  });
});

describe('when the bucket fails', () => {
  beforeEach(connected);

  it('a hold that needs a copy fails with a code for people; a copy not stored stays on the disk until it is', async () => {
    put(areaDir(root, olga), 'a.txt', 'one');
    await (await storage.hold(olga, 'write'))();
    await storage.sweep();
    s3.outage(true);
    await expect(storage.hold(olga, 'read')).rejects.toMatchObject({ code: 'APP_STORAGE_UNAVAILABLE' });
    s3.outage(false);
    const release = await storage.hold(olga, 'write');
    put(areaDir(root, olga), 'b.txt', 'two');
    s3.outage(true);
    await release();
    await storage.sweep();
    expect(read(areaDir(root, olga), 'b.txt')).toBe('two');
    expect((await storage.status()).lastError).toMatchObject({ code: 'APP_STORAGE_UNAVAILABLE' });
    s3.outage(false);
    await storage.sweep();
    expect(bucketKeys()).toEqual(['bba/users/olga/files/a.txt', 'bba/users/olga/files/b.txt']);
    expect(existsSync(areaDir(root, olga))).toBe(false);
    expect((await storage.status()).lastError).toBeNull();
  }, 30_000);
});

describe('what the review of 17.11 found', () => {
  beforeEach(connected);

  it('a file whose place is taken in the copy is kept in «Восстановлено из хранилища», never dropped', async () => {
    const release = await storage.hold(olga, 'write');
    put(areaDir(root, olga), 'a', 'file a');
    await release();
    await storage.sweep();
    // The bucket holds «a» and, from a pass broken halfway, «a/b» too.
    s3.objects.set('bba/users/olga/files/a/b', Buffer.from('file a/b'));
    await db.query("INSERT INTO app.storage_objects (area, path, bytes, mtime_ms) VALUES ('users/olga/files', 'a/b', 8, 1)");
    const again = await storage.hold(olga, 'write');
    const placed = [read(areaDir(root, olga), 'a'), read(areaDir(root, olga), 'Восстановлено из хранилища/a/b')].sort();
    expect(placed).toEqual(['file a', 'file a/b']);
    await again();
    expect(bucketKeys()).toEqual(['bba/users/olga/files/a', 'bba/users/olga/files/Восстановлено из хранилища/a/b']);
  });

  it('a missing bucket fails the hold and keeps the list of what it held', async () => {
    put(areaDir(root, olga), 'a.txt', 'one');
    await (await storage.hold(olga, 'write'))();
    await storage.sweep();
    s3.failWith({ status: 404, code: 'NoSuchBucket' });
    try {
      await expect(storage.hold(olga, 'read')).rejects.toMatchObject({ code: 'APP_STORAGE_BUCKET_NOT_FOUND' });
    } finally {
      s3.failWith(null);
    }
    expect((await storage.status()).stored.files).toBe(1);
    const release = await storage.hold(olga, 'read');
    expect(read(areaDir(root, olga), 'a.txt')).toBe('one');
    await release();
  });

  it('a file the bucket refuses or a name in an old code page keeps the copy on the disk; the rest is stored', async () => {
    const release = await storage.hold(olga, 'write');
    put(areaDir(root, olga), 'ok.txt', 'fine');
    put(areaDir(root, olga), 'huge.bin', 'refused');
    // «Договор» in cp866, as unzip leaves a ZIP of Windows.
    writeFileSync(Buffer.concat([Buffer.from(`${areaDir(root, olga)}/`), Buffer.from([0x84, 0xae, 0xa3, 0xae, 0xa2, 0xae, 0xe0])]), 'cp866');
    s3.refuseKeys('huge.bin');
    await release();
    expect(bucketKeys()).toEqual(['bba/users/olga/files/ok.txt']);
    await storage.sweep();
    expect(read(areaDir(root, olga), 'huge.bin')).toBe('refused');
    expect((await storage.status()).lastError?.code).toBe('APP_STORAGE_SYNC_INCOMPLETE');
    s3.refuseKeys(null);
    await storage.sweep();
    // Stored now, but the name nobody can read keeps the copy.
    expect(bucketKeys()).toContain('bba/users/olga/files/huge.bin');
    expect(existsSync(areaDir(root, olga))).toBe(true);
    expect((await storage.status()).lastError?.code).toBe('APP_STORAGE_NAME_UNSUPPORTED');
  });

  it('one file is read and found without bringing the area to the disk', async () => {
    const release = await storage.hold(tender, 'write');
    put(areaDir(root, tender), 'files/смета.xlsx', 'smeta');
    await release();
    await storage.sweep();
    expect(await storage.exists(tender, 'files/смета.xlsx')).toBe(true);
    expect(await storage.exists(tender, 'files/нет.xlsx')).toBe(false);
    const file = await storage.openFile(tender, 'files/смета.xlsx');
    const chunks: Buffer[] = [];
    for await (const c of file!.stream) chunks.push(Buffer.from(c as Uint8Array));
    expect({ text: Buffer.concat(chunks).toString(), bytes: file!.bytes }).toEqual({ text: 'smeta', bytes: 5 });
    expect(await storage.openFile(tender, 'files/нет.xlsx')).toBeNull();
    await expect(storage.exists(tender, '../../x')).rejects.toMatchObject({ code: 'APP_VALIDATION_FAILED' });
    expect(existsSync(areaDir(root, tender))).toBe(false);
  });

  it('a held area is not moved from under the answer', async () => {
    const release = await storage.hold(tender, 'write');
    await expect(storage.exclusiveIdle(tender, () => 'moved')).rejects.toMatchObject({ code: 'APP_STORAGE_BUSY' });
    await release();
    expect(await storage.exclusiveIdle(tender, () => 'moved')).toBe('moved');
  });
});

describe('disconnecting', () => {
  beforeEach(connected);

  it('brings every file back to the disk and forgets the bucket', async () => {
    const r1 = await storage.hold(olga, 'write');
    put(areaDir(root, olga), 'a.txt', 'one');
    await r1();
    const r2 = await storage.hold(tender, 'write');
    put(areaDir(root, tender), 'files/b.txt', 'two');
    await r2();
    await storage.sweep();
    await storage.disconnect();
    await expect(storage.disconnect()).rejects.toMatchObject({ code: 'APP_STORAGE_BUSY' });
    await storage.sweep();
    expect(read(areaDir(root, olga), 'a.txt')).toBe('one');
    expect(read(areaDir(root, tender), 'files/b.txt')).toBe('two');
    expect(bucketKeys()).toEqual([]);
    expect(await storage.status()).toMatchObject({ mode: 'local', state: 'active', bucket: null });
  });
});

// Model-based: whatever a person and the agent do to the files between holds, passes and outages, the
// bucket after the last pass holds exactly the files the model says.
describe('the copies as a whole', () => {
  beforeEach(connected);

  const step = fc.oneof(
    fc.record({ kind: fc.constant('write' as const), file: fc.constantFrom('a.txt', 'b/c.txt', 'b/d.txt', 'e.txt'), text: fc.string({ minLength: 0, maxLength: 5 }) }),
    fc.record({ kind: fc.constant('remove' as const), file: fc.constantFrom('a.txt', 'b/c.txt', 'b/d.txt', 'e.txt') }),
    fc.record({ kind: fc.constant('sweep' as const) }),
  );

  it('the bucket ends with what was written and not removed', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.array(step, { maxLength: 6 }), { minLength: 1, maxLength: 4 }), async (holds) => {
        const area = userArea(`p${randomUUID().slice(0, 8)}`);
        const model = new Map<string, string>();
        for (const steps of holds) {
          const release = await storage.hold(area, 'write');
          for (const s of steps) {
            const path = join(areaDir(root, area), s.kind === 'sweep' ? '' : s.file);
            if (s.kind === 'write') {
              mkdirSync(dirname(path), { recursive: true });
              writeFileSync(path, s.text);
              // A write within the same millisecond as the last one keeps size and time when the text is as long.
              utimesSync(path, new Date(), new Date(Date.now() + model.size * 1000 + Math.random() * 1e6));
              model.set(s.file, s.text);
            } else if (s.kind === 'remove') {
              rmSync(path, { force: true });
              model.delete(s.file);
            } else await storage.sweep();
          }
          await release();
          await storage.sweep();
        }
        const prefix = `bba/users/${area.kind === 'user' ? area.userId : ''}/files/`;
        const stored = new Map([...s3.objects].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v.toString()]));
        expect(stored).toEqual(model);
      }),
      { numRuns: 15 },
    );
  }, 60_000);
});
