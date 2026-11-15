// Skills of the installation (spec, scenario 10, section 8.15): the admin uploads a `.skill` file,
// chooses who gets it, switches it off, replaces it with a new version or removes it. The archive is
// kept in the database; its unpacked copy for the agents is in APP_SKILLS_DIR/<sha256>/<name>.
// System skills of the core (section 8.18) are listed first and refuse every change; their names
// cannot be taken by an uploaded skill.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillAccess, SkillDto, SkillFile, SkillPreview, SkillsResponse, SkillUpdate } from '@bba/contracts';
import type pg from 'pg';
import { writeAudit } from '../audit/audit.ts';
import { checkScope, writeScopeTargets } from '../auth/scope.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { sandboxContents } from '../sandbox/environment.ts';
import { invalidSkill, readSkillArchive, writeSkillFiles, type SkillPackage } from './archive.ts';
import type { SystemSkill } from './system.ts';

export interface SkillsDeps {
  db: Db;
  skillsDir: string;
  // core/system-skills, loaded once at the start (loadSystemSkills).
  systemSkills: SystemSkill[];
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

// A copy of a skill: <skillsDir>/<sha256>/<name>/. Mastra takes a skill only from a folder named as
// the skill (the name in its SKILL.md); the version folder keeps the copy a running answer still reads.
export function skillDir(skillsDir: string, name: string, sha256: string): string {
  return join(skillsDir, sha256, name);
}

// Removes the copies `drop` points at; a version folder left empty goes too. Folders of the old
// layout <name>/<sha256> look like a version with unknown skills, so they go as well.
export function removeSkillCopies(skillsDir: string, drop: (name: string, sha256: string) => boolean): void {
  if (!existsSync(skillsDir)) return;
  for (const version of readdirSync(skillsDir)) {
    const dir = join(skillsDir, version);
    if (!statSync(dir).isDirectory()) {
      rmSync(dir, { force: true });
      continue;
    }
    for (const name of readdirSync(dir)) if (drop(name, version)) rmSync(join(dir, name), { recursive: true, force: true });
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  }
}

const notFound = (name: string) => appError('APP_NOT_FOUND', `skill ${name} not found`, { userMessage: 'Скилл не найден. Обновите страницу.' });

const isSystem = (deps: SkillsDeps, name: string) => deps.systemSkills.some((s) => s.name === name);

function refuseSystem(deps: SkillsDeps, name: string): void {
  if (isSystem(deps, name)) throw appError('APP_SKILL_SYSTEM', `system skill ${name} cannot be changed`);
}

function refuseSystemName(deps: SkillsDeps, name: string): void {
  if (!isSystem(deps, name)) return;
  throw appError('APP_SKILL_SYSTEM', `skill name ${name} belongs to a system skill`, {
    userMessage: `Имя «${name}» занято системным скиллом. Переименуйте скилл (поле name в SKILL.md) и загрузите снова.`,
  });
}

function systemDto(s: SystemSkill): SkillDto {
  return {
    name: s.name,
    title: s.title,
    description: s.description,
    sizeBytes: s.sizeBytes,
    files: s.files,
    hasScripts: s.hasScripts,
    enabled: true,
    access: { scope: 'org', departmentIds: [], userIds: [] },
    system: true,
    uploadedAt: null,
    uploadedBy: null,
  };
}

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
    system: false,
    uploadedAt: r.uploaded_at.toISOString(),
    uploadedBy: r.uploaded_by,
  };
}

async function dtoOf(db: Db, name: string): Promise<SkillDto> {
  const [row] = await rows(db, name);
  if (!row) throw notFound(name);
  return toDto(row);
}

export async function listSkills(deps: SkillsDeps): Promise<SkillsResponse> {
  const uploaded = (await rows(deps.db)).filter((r) => !isSystem(deps, r.name)).map(toDto);
  return { skills: [...deps.systemSkills.map(systemDto), ...uploaded], sandbox: sandboxContents() };
}

export async function previewSkill(deps: SkillsDeps, archive: Uint8Array): Promise<SkillPreview> {
  const pkg = readSkillArchive(archive);
  refuseSystemName(deps, pkg.name);
  const { rowCount } = await deps.db.query('SELECT 1 FROM app.skills WHERE name = $1', [pkg.name]);
  return { name: pkg.name, title: pkg.title, description: pkg.description, sizeBytes: pkg.sizeBytes, files: filesOf(pkg), hasScripts: pkg.hasScripts, exists: (rowCount ?? 0) > 0 };
}

async function writeScope(c: pg.PoolClient, name: string, access: SkillAccess): Promise<void> {
  await c.query('UPDATE app.skills SET scope = $2 WHERE name = $1', [name, access.scope]);
  await writeScopeTargets(c, 'skill', name, access);
}

export async function createSkill(deps: SkillsDeps, actorUserId: string, archive: Uint8Array, rawAccess: SkillAccess): Promise<SkillDto> {
  const pkg = readSkillArchive(archive);
  refuseSystemName(deps, pkg.name);
  await inTransaction(deps.db, async (c) => {
    const access = await checkScope(c, rawAccess);
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
  refuseSystem(deps, name);
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
  refuseSystem(deps, name);
  await dtoOf(deps.db, name);
  await inTransaction(deps.db, async (c) => {
    if (change.enabled !== undefined) await c.query('UPDATE app.skills SET enabled = $2 WHERE name = $1', [name, change.enabled]);
    const access = change.access ? await checkScope(c, change.access) : undefined;
    if (access) await writeScope(c, name, access);
    await writeAudit(c, { actorUserId, action: 'skill.update', target: name, details: { enabled: change.enabled, access } });
  });
  return dtoOf(deps.db, name);
}

export async function deleteSkill(deps: SkillsDeps, actorUserId: string, name: string): Promise<void> {
  refuseSystem(deps, name);
  await dtoOf(deps.db, name);
  await inTransaction(deps.db, async (c) => {
    await c.query('DELETE FROM app.skills WHERE name = $1', [name]);
    await writeAudit(c, { actorUserId, action: 'skill.delete', target: name });
  });
  removeSkillCopies(deps.skillsDir, (copy) => copy === name);
}
