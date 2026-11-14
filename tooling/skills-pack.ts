// pnpm skills:pack [<folder of a skill>…] — packs skill sources into `.skill` files for «Скиллы»
// in the admin panel, next to their folders: skills/read-documents → skills/read-documents.skill.
// Without arguments packs every folder of skills/. The same sources give the same bytes.
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packSkill, readSkillArchive } from '../core/skills-admin/archive.ts';

const SKILLS = fileURLToPath(new URL('../skills', import.meta.url));
const args = process.argv.slice(2);
const folders = args.length > 0 ? args.map((a) => resolve(a)) : readdirSync(SKILLS).map((d) => join(SKILLS, d)).filter((d) => statSync(d).isDirectory());

for (const folder of folders) {
  const archive = packSkill(folder);
  const pkg = readSkillArchive(archive); // the same checks the admin panel makes
  writeFileSync(`${folder}.skill`, archive);
  console.log(`${folder}.skill: «${pkg.title}», ${pkg.files.size} files, ${archive.length} bytes`);
}
