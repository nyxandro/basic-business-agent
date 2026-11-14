// Skills of the installation (spec, scenario 10, section 8.15): the admin uploads a `.skill` file,
// chooses who gets it, switches it off, replaces it with a new version or removes it. The archive is
// kept in the database; its unpacked copy for the agents is in APP_SKILLS_DIR/<name>/<sha256>.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillAccess, SkillDto, SkillFile, SkillPreview, SkillsResponse, SkillUpdate } from '@bba/contracts';
import type pg from 'pg';
import { writeAudit } from '../audit/audit.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { invalidSkill, readSkillArchive, writeSkillFiles, type SkillPackage } from './archive.ts';

// The libraries of the sandbox's Python, the same list the image and `pnpm skills:setup` install.
const REQUIREMENTS = new URL('../sandbox/requirements.txt', import.meta.url);

export interface SkillsDeps {
  db: Db;
  skillsDir: string;
}

interface SkillRow {
  name: string;
  title: string;
  description: string;
  sha256: string;
  size_bytes: number;
  files: SkillFile[];
  has_scripts: boolean;
  enabled: boolean;
  scope: SkillAccess['scope'];
  uploaded_at: Date;
  uploaded_by: string | null;
  department_ids: string[];
  user_ids: string[];
}

const UNIQUE_VIOLATION = '23505';

export function sandboxLibraries(): string[] {
  return readFileSync(REQUIREMENTS, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/[=<>~! ]/)[0]!);
}

export function skillDir(skillsDir: string, name: string, sha256: string): string {
  return join(skillsDir, name, sha256);
}

const notFound = (name: string) => appError('APP_NOT_FOUND', `skill ${name} not found`, { userMessage: 'Скилл не найден. Обновите страницу.' });

function filesOf(pkg: SkillPackage): SkillFile[] {
  return [...pkg.files.entries()].map(([path, data]) => ({ path, bytes: data.length })).sort((a, b) => a.path.localeCompare(b.path));
}

async function rows(db: Db, name?: string): Promise<SkillRow[]> {
  const { rows: found } = await db.query<SkillRow>(
    `SELECT s.name, s.title, s.description, s.sha256, s.size_bytes, s.files, s.has_scripts, s.enabled, s.scope, s.uploaded_at, u."name" AS uploaded_by,
            coalesce(array_agg(sc.department_id::text) FILTER (WHERE sc.department_id IS NOT NULL), '{}') AS department_ids,
            coalesce(array_agg(sc.user_id) FILTER (WHERE sc.user_id IS NOT NULL), '{}') AS user_ids
       FROM app.skills s
       LEFT JOIN app.skill_scope sc ON sc.skill_name = s.name
       LEFT JOIN app."user" u ON u."id" = s.uploaded_by
      WHERE $1::text IS NULL OR s.name = $1
      GROUP BY s.name, u."name"
      ORDER BY s.title, s.name`,
    [name ?? null],
  );
  return found;
}

function toDto(r: SkillRow): SkillDto {
  return {
    name: r.name,
    title: r.title,
    description: r.description,
    sizeBytes: r.size_bytes,
    files: r.files,
    hasScripts: r.has_scripts,
    enabled: r.enabled,
    access: { scope: r.scope, departmentIds: [...r.department_ids].sort(), userIds: [...r.user_ids].sort() },
    uploadedAt: r.uploaded_at.toISOString(),
    uploadedBy: r.uploaded_by,
  };
}

async function dtoOf(db: Db, name: string): Promise<SkillDto> {
  const [row] = await rows(db, name);
  if (!row) throw notFound(name);
  return toDto(row);
}

export async function listSkills(db: Db): Promise<SkillsResponse> {
  return { skills: (await rows(db)).map(toDto), libraries: sandboxLibraries() };
}

export async function previewSkill(db: Db, archive: Uint8Array): Promise<SkillPreview> {
  const pkg = readSkillArchive(archive);
  const { rowCount } = await db.query('SELECT 1 FROM app.skills WHERE name = $1', [pkg.name]);
  return { name: pkg.name, title: pkg.title, description: pkg.description, sizeBytes: pkg.sizeBytes, files: filesOf(pkg), hasScripts: pkg.hasScripts, exists: (rowCount ?? 0) > 0 };
}

// Departments or employees of the scope must exist; "everyone in the organisation" takes no list.
async function checkAccess(db: Pick<pg.PoolClient, 'query'>, access: SkillAccess): Promise<SkillAccess> {
  if (access.scope === 'org') return { scope: 'org', departmentIds: [], userIds: [] };
  const ids = access.scope === 'departments' ? [...new Set(access.departmentIds)] : [...new Set(access.userIds)];
  if (ids.length === 0) throw appError('APP_VALIDATION_FAILED', `scope ${access.scope} without targets`, { userMessage: access.scope === 'departments' ? 'Выберите хотя бы один отдел.' : 'Выберите хотя бы одного сотрудника.' });
  const { rowCount } = await db.query(access.scope === 'departments' ? 'SELECT 1 FROM app.departments WHERE id = ANY($1::uuid[])' : 'SELECT 1 FROM app."user" WHERE "id" = ANY($1)', [ids]);
  if (rowCount !== ids.length) throw appError('APP_VALIDATION_FAILED', `unknown ${access.scope} in skill scope`, { userMessage: 'Некоторых отделов или сотрудников уже нет. Обновите страницу.' });
  return access.scope === 'departments' ? { scope: 'departments', departmentIds: ids, userIds: [] } : { scope: 'users', departmentIds: [], userIds: ids };
}

async function writeScope(c: pg.PoolClient, name: string, access: SkillAccess): Promise<void> {
  await c.query('UPDATE app.skills SET scope = $2 WHERE name = $1', [name, access.scope]);
  await c.query('DELETE FROM app.skill_scope WHERE skill_name = $1', [name]);
  for (const id of access.departmentIds) await c.query('INSERT INTO app.skill_scope (skill_name, department_id) VALUES ($1, $2)', [name, id]);
  for (const id of access.userIds) await c.query('INSERT INTO app.skill_scope (skill_name, user_id) VALUES ($1, $2)', [name, id]);
}

export async function createSkill(deps: SkillsDeps, actorUserId: string, archive: Uint8Array, rawAccess: SkillAccess): Promise<SkillDto> {
  const pkg = readSkillArchive(archive);
  await inTransaction(deps.db, async (c) => {
    const access = await checkAccess(c, rawAccess);
    try {
      await c.query(
        `INSERT INTO app.skills (name, title, description, archive, sha256, size_bytes, files, has_scripts, scope, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [pkg.name, pkg.title, pkg.description, Buffer.from(archive), pkg.sha256, pkg.sizeBytes, JSON.stringify(filesOf(pkg)), pkg.hasScripts, access.scope, actorUserId],
      );
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      throw appError('APP_SKILL_EXISTS', `skill ${pkg.name} exists`, { cause: error, userMessage: `Скилл «${pkg.name}» уже загружен. Чтобы обновить его, нажмите «Заменить».` });
    }
    await writeScope(c, pkg.name, access);
    await writeAudit(c, { actorUserId, action: 'skill.upload', target: pkg.name, details: { sha256: pkg.sha256, access } });
  });
  writeSkillFiles(pkg.files, skillDir(deps.skillsDir, pkg.name, pkg.sha256));
  return dtoOf(deps.db, pkg.name);
}

// A new version: answers already running keep the old copy (another sha256 folder) to the end.
export async function replaceSkill(deps: SkillsDeps, actorUserId: string, name: string, archive: Uint8Array): Promise<SkillDto> {
  await dtoOf(deps.db, name);
  const pkg = readSkillArchive(archive);
  if (pkg.name !== name) throw invalidSkill(`в файле другой скилл — «${pkg.name}», а заменяется «${name}»`);
  const dir = skillDir(deps.skillsDir, pkg.name, pkg.sha256);
  if (!existsSync(dir)) writeSkillFiles(pkg.files, dir);
  await inTransaction(deps.db, async (c) => {
    await c.query(
      `UPDATE app.skills SET title = $2, description = $3, archive = $4, sha256 = $5, size_bytes = $6, files = $7, has_scripts = $8, uploaded_by = $9, uploaded_at = now()
        WHERE name = $1`,
      [name, pkg.title, pkg.description, Buffer.from(archive), pkg.sha256, pkg.sizeBytes, JSON.stringify(filesOf(pkg)), pkg.hasScripts, actorUserId],
    );
    await writeAudit(c, { actorUserId, action: 'skill.replace', target: name, details: { sha256: pkg.sha256 } });
  });
  return dtoOf(deps.db, name);
}

export async function updateSkill(deps: SkillsDeps, actorUserId: string, name: string, change: SkillUpdate): Promise<SkillDto> {
  await dtoOf(deps.db, name);
  await inTransaction(deps.db, async (c) => {
    if (change.enabled !== undefined) await c.query('UPDATE app.skills SET enabled = $2 WHERE name = $1', [name, change.enabled]);
    const access = change.access ? await checkAccess(c, change.access) : undefined;
    if (access) await writeScope(c, name, access);
    await writeAudit(c, { actorUserId, action: 'skill.update', target: name, details: { enabled: change.enabled, access } });
  });
  return dtoOf(deps.db, name);
}

export async function deleteSkill(deps: SkillsDeps, actorUserId: string, name: string): Promise<void> {
  await dtoOf(deps.db, name);
  await inTransaction(deps.db, async (c) => {
    await c.query('DELETE FROM app.skills WHERE name = $1', [name]);
    await writeAudit(c, { actorUserId, action: 'skill.delete', target: name });
  });
  rmSync(join(deps.skillsDir, name), { recursive: true, force: true });
}
