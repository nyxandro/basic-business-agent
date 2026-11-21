import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSystemSkills, SYSTEM_SKILLS_DIR } from './system.ts';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function skill(folder: string, name = folder): void {
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Does things\n---\n\n# Things\n`);
}

describe('system skills of the core', () => {
  it('loads the document skills and the letterhead with the Russian names of the admin panel', () => {
    dir = mkdtempSync(join(tmpdir(), 'bba-system-'));
    const skills = loadSystemSkills(SYSTEM_SKILLS_DIR);
    expect(skills.map((s) => [s.name, s.title])).toEqual([
      ['docx', 'Документы Word'],
      ['letterhead', 'Бланк организации'],
      ['pdf', 'PDF'],
      ['pptx', 'Презентации PowerPoint'],
      ['xlsx', 'Таблицы Excel'],
    ]);
    for (const s of skills) {
      expect(s.dir).toBe(join(SYSTEM_SKILLS_DIR, s.name));
      // The letterhead is the core's own, without scripts or a licence of its own (docs/specs/[20.11.2026]-org-letterhead.md).
      if (s.name === 'letterhead') continue;
      expect(s.hasScripts).toBe(true);
      expect(s.files.map((f) => f.path)).toContain('SKILL.md');
      expect(s.files.map((f) => f.path)).toContain('LICENSE.txt');
    }
  });

  it('stops the start when a folder is not named as its skill, has no line in the manifest, or a line has no folder', () => {
    dir = mkdtempSync(join(tmpdir(), 'bba-system-'));
    skill('docx', 'word');
    expect(() => loadSystemSkills(dir, { docx: { title: 'Word', description: 'x' } })).toThrow(expect.objectContaining({ code: 'APP_CONFIG_INVALID', message: expect.stringContaining('core/system-skills/docx') }));
    rmSync(join(dir, 'docx'), { recursive: true });
    skill('notes');
    expect(() => loadSystemSkills(dir, {})).toThrow(expect.objectContaining({ code: 'APP_CONFIG_INVALID', message: expect.stringContaining('notes') }));
    expect(() => loadSystemSkills(dir, { notes: { title: 'Заметки', description: 'x' }, pdf: { title: 'PDF', description: 'x' } })).toThrow(expect.objectContaining({ code: 'APP_CONFIG_INVALID', message: expect.stringContaining('pdf') }));
    expect(loadSystemSkills(dir, { notes: { title: 'Заметки', description: 'Пишет заметки' } })).toMatchObject([{ name: 'notes', title: 'Заметки', description: 'Пишет заметки', hasScripts: false }]);
  });
});
