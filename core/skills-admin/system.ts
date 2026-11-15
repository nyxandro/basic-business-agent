// System skills of the core (spec, section 8.18): folders of core/system-skills that every employee
// gets and nobody can switch off, replace or remove. They are not in the database: the folder is the
// source and changes only with a version of the core. Each folder goes through the same checks as an
// uploaded `.skill` (name, description, sizes, no links), so a broken copy stops the start.
import type { SkillFile } from '@bba/contracts';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configError, type ConfigProblem } from '../config/validate.ts';
import { isAppError } from '../errors/app-error.ts';
import { SYSTEM_SKILL_TITLES } from '../system-skills/manifest.ts';
import { packSkill, readSkillArchive } from './archive.ts';

export const SYSTEM_SKILLS_DIR = fileURLToPath(new URL('../system-skills', import.meta.url));

export interface SystemSkill {
  name: string;
  // For people (the admin panel), from the manifest of the core.
  title: string;
  description: string;
  // The folder the agents get (Mastra takes a skill from a folder named as the skill).
  dir: string;
  sizeBytes: number;
  files: SkillFile[];
  hasScripts: boolean;
}

const at = (name: string) => `core/system-skills/${name}`;

export function loadSystemSkills(dir: string, titles: Record<string, { title: string; description: string }> = SYSTEM_SKILL_TITLES): SystemSkill[] {
  const folders = readdirSync(dir)
    .filter((f) => statSync(join(dir, f)).isDirectory())
    .sort();
  const problems: ConfigProblem[] = [];
  const skills: SystemSkill[] = [];
  let cause: unknown;
  for (const folder of folders) {
    const named = titles[folder];
    if (!named) {
      problems.push({ file: 'core/system-skills/manifest.ts', field: folder, message: `the folder ${at(folder)} has no title in the manifest` });
      continue;
    }
    try {
      const pkg = readSkillArchive(packSkill(join(dir, folder)));
      skills.push({
        name: pkg.name,
        title: named.title,
        description: named.description,
        dir: join(dir, folder),
        sizeBytes: pkg.sizeBytes,
        files: [...pkg.files.entries()].map(([path, data]) => ({ path, bytes: data.length })).sort((a, b) => a.path.localeCompare(b.path)),
        hasScripts: pkg.hasScripts,
      });
    } catch (error) {
      if (!isAppError(error)) throw error;
      cause ??= error;
      problems.push({ file: `${at(folder)}/SKILL.md`, field: '(skill)', message: error.message });
    }
  }
  for (const name of Object.keys(titles)) {
    if (!folders.includes(name)) problems.push({ file: 'core/system-skills/manifest.ts', field: name, message: `there is no folder ${at(name)}` });
  }
  if (problems.length > 0) throw configError(problems, cause);
  return skills;
}
