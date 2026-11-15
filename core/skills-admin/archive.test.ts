import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { packSkill, readSkillArchive, removeSkillFolder, writeSkillFiles } from './archive.ts';

// A real skill with scripts: the PDF skill of the core (spec, section 8.18).
const PDF = fileURLToPath(new URL('../system-skills/pdf', import.meta.url));
const SKILLS = fileURLToPath(new URL('../../skills', import.meta.url));
const text = (s: string) => new TextEncoder().encode(s);
const skillMd = (name = 'notes', heading = '# Заметки') => text(`---\nname: ${name}\ndescription: >\n  Ведёт заметки\n  сотрудника\n---\n\n${heading}\n\nТекст.\n`);
const zip = (tree: Zippable) => zipSync(tree);
const refusal = (archive: Uint8Array) => {
  try {
    readSkillArchive(archive);
  } catch (error) {
    return error as { code: string; userMessage: string };
  }
  throw new Error('expected APP_SKILL_INVALID');
};

describe('the .skill archive', () => {
  it('reads a skill folder: name, title from the heading, description, scripts', () => {
    const pkg = readSkillArchive(packSkill(PDF));
    expect(pkg).toMatchObject({ name: 'pdf', title: 'PDF Processing Guide', hasScripts: true });
    expect(pkg.description).toContain('PDF');
    expect([...pkg.files.keys()]).toEqual(expect.arrayContaining(['SKILL.md', 'LICENSE.txt', 'scripts/fill_fillable_fields.py']));
  });

  it('keeps every packed file of the repository equal to its sources (pnpm skills:pack)', () => {
    const folders = readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(SKILLS, e.name));
    expect(folders.length).toBeGreaterThan(0);
    for (const folder of folders) expect(Buffer.from(readFileSync(`${folder}.skill`)).equals(Buffer.from(packSkill(folder))), folder).toBe(true);
  });

  it('takes folded YAML and a skill without scripts; the title falls back to the name', () => {
    const pkg = readSkillArchive(zip({ 'notes/SKILL.md': skillMd('notes', 'Без заголовка') }));
    expect(pkg).toMatchObject({ name: 'notes', title: 'notes', description: 'Ведёт заметки сотрудника', hasScripts: false });
  });

  it('refuses paths out of the skill folder, absolute paths and backslashes', () => {
    for (const bad of ['notes/../../etc/passwd', '/notes/SKILL.md', 'notes\\..\\x']) {
      expect(refusal(zip({ 'notes/SKILL.md': skillMd(), [bad]: text('x') })).code).toBe('APP_SKILL_INVALID');
    }
  });

  it('refuses a link inside the archive', () => {
    const link = zip({ 'notes/SKILL.md': skillMd(), 'notes/secret': [text('/etc/passwd'), { os: 3, attrs: 0o120777 << 16 }] });
    expect(refusal(link).userMessage).toContain('ссылка');
  });

  it('refuses an archive without SKILL.md, with two folders, with a misnamed folder or a bad name', () => {
    expect(refusal(zip({ 'notes/README.md': text('x') })).userMessage).toContain('нет SKILL.md');
    expect(refusal(zip({ 'notes/SKILL.md': skillMd(), 'other/x.txt': text('x') })).code).toBe('APP_SKILL_INVALID');
    expect(refusal(zip({ 'SKILL.md': skillMd() })).code).toBe('APP_SKILL_INVALID');
    expect(refusal(zip({ 'notes-v2/SKILL.md': skillMd('notes') })).userMessage).toContain('должна называться как скилл');
    expect(refusal(zip({ 'Notes/SKILL.md': skillMd('Notes') })).code).toBe('APP_SKILL_INVALID');
    expect(refusal(text('not a zip')).userMessage).toContain('не zip');
  });

  it('refuses a file over 10 MB, more than 500 files and more than 50 MB unpacked — before unpacking', () => {
    expect(refusal(new Uint8Array(10 * 1024 * 1024 + 1)).userMessage).toContain('больше 10 МБ');
    const many: Zippable = { 'notes/SKILL.md': skillMd() };
    for (let i = 0; i < 500; i++) many[`notes/f${i}.txt`] = text('x');
    expect(refusal(zip(many)).userMessage).toContain('больше 500 файлов');
    const bomb = zip({ 'notes/SKILL.md': skillMd(), 'notes/zeros.bin': new Uint8Array(51 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(refusal(bomb).userMessage).toContain('больше 50 МБ');
  });

  it('refuses an archive whose table of contents lies about a file', () => {
    const archive = zip({ 'notes/SKILL.md': skillMd(), 'notes/data.bin': new Uint8Array(100_000) });
    const view = new DataView(archive.buffer);
    let end = archive.length - 22;
    while (view.getUint32(end, true) !== 0x06054b50) end--;
    let entry = view.getUint32(end + 16, true);
    for (let i = 0; i < 2; i++) {
      const name = new TextDecoder().decode(archive.subarray(entry + 46, entry + 46 + view.getUint16(entry + 28, true)));
      if (name === 'notes/data.bin') view.setUint32(entry + 24, 100, true);
      entry += 46 + view.getUint16(entry + 28, true) + view.getUint16(entry + 30, true) + view.getUint16(entry + 32, true);
    }
    expect(refusal(archive).userMessage).toContain('повреждён');
  });

  it('writes the files of a skill into its folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'bba-skill-'));
    try {
      const pkg = readSkillArchive(packSkill(PDF));
      writeSkillFiles(pkg.files, join(root, 'pdf', pkg.sha256));
      expect(readFileSync(join(root, 'pdf', pkg.sha256, 'scripts', 'fill_fillable_fields.py'), 'utf8')).toContain('pypdf');
    } finally {
      removeSkillFolder(root);
    }
  });
});
