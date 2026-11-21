// The letterhead (its copy without text) and the logo on disk for agents (docs/specs/[20.11.2026]-org-letterhead.md):
// <dir>/<sha256>/blank.docx and logo.png, the folder open read-only to the sandbox of every answer, as the skills are.
// A copy of what the database keeps, laid out at the first need after an upload or a start; a replaced file keeps its
// folder until the next start, so an answer that began on it finishes. The stamp and the signature are never here.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/pool.ts';

export const ORG_FILES_DIR = 'bba-org-files';

export interface OrgFilePaths {
  blank: string | null;
  logo: string | null;
}

const NAMES = { blank: 'blank.docx', logo: 'logo.png' } as const;

function layOut(dir: string, sha256: string, name: string, bytes: Buffer): string {
  const folder = join(dir, sha256);
  const path = join(folder, name);
  if (existsSync(path)) return path;
  mkdirSync(folder, { recursive: true });
  // Written aside and moved: a script never reads half a file.
  const part = `${path}.${process.pid}.part`;
  writeFileSync(part, bytes);
  renameSync(part, path);
  return path;
}

// The paths an answer names to the agent, the files laid out if they are not yet.
export async function orgFilePaths(db: Db, dir: string): Promise<OrgFilePaths> {
  const { rows } = await db.query<{ kind: 'blank' | 'logo'; sha256: string }>("SELECT kind, sha256 FROM app.org_assets WHERE kind IN ('blank', 'logo')");
  const paths: OrgFilePaths = { blank: null, logo: null };
  for (const row of rows) {
    const path = join(dir, row.sha256, NAMES[row.kind]);
    if (existsSync(path)) {
      paths[row.kind] = path;
      continue;
    }
    // The agent writes on the copy without text; the logo is as uploaded.
    const column = row.kind === 'blank' ? 'prepared' : 'content';
    const { rows: found } = await db.query<{ bytes: Buffer }>(`SELECT ${column} AS bytes FROM app.org_assets WHERE kind = $1 AND sha256 = $2`, [row.kind, row.sha256]);
    // Replaced meanwhile: the next answer gets what is there then.
    if (found[0]) paths[row.kind] = layOut(dir, row.sha256, NAMES[row.kind], found[0].bytes);
  }
  return paths;
}

// At the start of the server: the folder exists before any sandbox opens it, copies of replaced files go.
export async function prepareOrgFiles(db: Db, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const { rows } = await db.query<{ sha256: string }>("SELECT sha256 FROM app.org_assets WHERE kind IN ('blank', 'logo')");
  const current = new Set(rows.map((r) => r.sha256));
  for (const name of readdirSync(dir)) if (!current.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
  await orgFilePaths(db, dir);
}
