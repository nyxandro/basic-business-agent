// The list of what the bucket holds (app.storage_objects, spec section 8.23). A row is written after its
// object is stored and removed before its object is: a failure in between leaves at worst an object no
// row names, never a row without its object.
import type { Db } from '../db/pool.ts';

export interface StoredRow {
  path: string;
  bytes: number;
  mtimeMs: number;
}

export async function storedRows(db: Db, area: string, prefix = ''): Promise<StoredRow[]> {
  const { rows } = await db.query<{ path: string; bytes: string; mtime_ms: string }>(
    prefix ? 'SELECT path, bytes, mtime_ms FROM app.storage_objects WHERE area = $1 AND starts_with(path, $2) ORDER BY path' : 'SELECT path, bytes, mtime_ms FROM app.storage_objects WHERE area = $1 ORDER BY path',
    prefix ? [area, prefix] : [area],
  );
  return rows.map((r) => ({ path: r.path, bytes: Number(r.bytes), mtimeMs: Number(r.mtime_ms) }));
}

export async function rememberStored(db: Db, area: string, row: StoredRow): Promise<void> {
  await db.query(
    `INSERT INTO app.storage_objects (area, path, bytes, mtime_ms, stored_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (area, path) DO UPDATE SET bytes = EXCLUDED.bytes, mtime_ms = EXCLUDED.mtime_ms, stored_at = now()`,
    [area, row.path, row.bytes, row.mtimeMs],
  );
}

export async function forgetStored(db: Db, area: string, path: string): Promise<void> {
  await db.query('DELETE FROM app.storage_objects WHERE area = $1 AND path = $2', [area, path]);
}

export async function storedAreas(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ area: string }>('SELECT DISTINCT area FROM app.storage_objects ORDER BY area');
  return rows.map((r) => r.area);
}

export async function storedTotals(db: Db): Promise<{ files: number; bytes: number }> {
  const { rows } = await db.query<{ files: string; bytes: string | null }>('SELECT count(*) AS files, sum(bytes) AS bytes FROM app.storage_objects');
  return { files: Number(rows[0]?.files ?? 0), bytes: Number(rows[0]?.bytes ?? 0) };
}
