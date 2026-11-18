// Versions of one document gather into a stack in «Файлы проекта» (decision of the owner 18.11): the
// same name in the same folder once the format and the version at its end are set aside.
import type { ProjectFile } from '@bba/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { documentOf, listEntries, type ListEntry } from './file-groups.ts';

const file = (path: string, bytes = 1024): ProjectFile => ({ path, bytes });
const shown = (entries: ListEntry[]) => entries.map((e) => (e.kind === 'file' ? e.file.path : `[${e.group.title}: ${e.group.files.map((f) => f.path).join(', ')}]`));

// The list from the owner's screen, as the server sorts it.
const TOP = ['Топ нейросетей для бизнес-агентов v2.pdf', 'Топ нейросетей для бизнес-агентов v2.pptx', 'Топ нейросетей для бизнес-агентов v3.pdf', 'Топ нейросетей для бизнес-агентов v3.pptx', 'Топ нейросетей для бизнес-агентов.pdf', 'Топ нейросетей для бизнес-агентов.pptx'];

describe('the document of a file', () => {
  it('sets aside the format and the version at the end of the name', () => {
    const plain = documentOf('Топ нейросетей для бизнес-агентов.pdf');
    expect(plain).toEqual({ key: 'топ нейросетей для бизнес-агентов', title: 'Топ нейросетей для бизнес-агентов', version: null });
    for (const name of ['Топ нейросетей для бизнес-агентов v2.pptx', 'Топ нейросетей для бизнес-агентов_V3.docx', 'Топ нейросетей для бизнес-агентов-v1.2.pdf', 'Топ нейросетей для бизнес-агентов (v4).xlsx', 'Топ нейросетей для бизнес-агентов.v5.pdf', 'Топ нейросетей для бизнес-агентов v 6.pdf']) {
      expect(documentOf(name).key).toBe(plain.key);
    }
    expect(documentOf('Отчёт v1.2.pdf').version).toBe('1.2');
  });

  it('does not take a v inside a word, a bare version or a number without v for a version', () => {
    expect(documentOf('Kiev2.pdf').key).toBe('kiev2');
    expect(documentOf('v2.pdf').key).toBe('v2');
    expect(documentOf('Смета 2.xlsx').key).toBe('смета 2');
    expect(documentOf('Резюме (2).docx').key).toBe('резюме (2)');
  });

  it('keeps folders apart and a name without a format as it is', () => {
    expect(documentOf('Почта/Счёт v2.pdf').key).toBe('Почта/счёт');
    expect(documentOf('Почта/Счёт v2.pdf').title).toBe('Почта/Счёт');
    expect(documentOf('Счёт v2.pdf').key).toBe('счёт');
    expect(documentOf('Docs/A v1.pdf').key).not.toBe(documentOf('docs/A v2.pdf').key);
    expect(documentOf('README').key).toBe('readme');
    expect(documentOf('.env').key).toBe('.env');
  });
});

describe('the list of «Файлы проекта»', () => {
  it('gathers the versions and formats of one document into one stack in the place of the first', () => {
    const files = [file('Акт.pdf'), ...TOP.map((p) => file(p)), file('Устав.docx')];
    expect(shown(listEntries(files, new Set()))).toEqual(['Акт.pdf', `[Топ нейросетей для бизнес-агентов: ${TOP.join(', ')}]`, 'Устав.docx']);
    const [, stack] = listEntries(files, new Set());
    expect(stack).toMatchObject({ kind: 'group', group: { versions: 3 } });
  });

  it('opens a stack into its files where they stand', () => {
    const files = [file('Отчёт v1.pdf'), file('Отчёт за май.pdf'), file('Отчёт.pdf')];
    const closed = listEntries(files, new Set());
    expect(shown(closed)).toEqual(['[Отчёт: Отчёт v1.pdf, Отчёт.pdf]', 'Отчёт за май.pdf']);
    const key = closed[0]!.kind === 'group' ? closed[0]!.group.key : '';
    expect(shown(listEntries(files, new Set([key])))).toEqual(['Отчёт v1.pdf', 'Отчёт за май.pdf', 'Отчёт.pdf']);
  });

  it('leaves a document of one file and documents in different folders as files', () => {
    expect(shown(listEntries([file('Счёт.pdf'), file('Почта/Счёт v2.pdf')], new Set()))).toEqual(['Счёт.pdf', 'Почта/Счёт v2.pdf']);
  });

  it('shows every file exactly once, in the order the server gave, whatever is opened', () => {
    const name = fc.constantFrom('Отчёт', 'Смета', 'Почта/Отчёт', 'Kiev', 'Резюме (2)');
    const version = fc.constantFrom('', ' v1', ' v2', '_V2', '-v1.2', ' (v3)');
    const format = fc.constantFrom('.pdf', '.docx', '.pptx', '');
    const files = fc.uniqueArray(fc.tuple(name, version, format).map(([n, v, f]) => `${n}${v}${f}`), { maxLength: 30 }).map((paths) => paths.map((p) => file(p)));
    fc.assert(
      fc.property(files, fc.array(fc.constantFrom('отчёт', 'смета', 'Почта/отчёт', 'kiev', 'резюме (2)'), { maxLength: 5 }), (list, opened) => {
        const entries = listEntries(list, new Set(opened));
        const flat = entries.flatMap((e) => (e.kind === 'file' ? [e.file] : e.group.files));
        // Every file once, and the stacks stand where their first file stood.
        expect(new Set(flat.map((f) => f.path)).size).toBe(list.length);
        expect(flat).toHaveLength(list.length);
        const firstOf = (e: ListEntry) => list.indexOf(e.kind === 'file' ? e.file : e.group.files[0]!);
        expect(entries.map(firstOf)).toEqual([...entries.map(firstOf)].sort((a, b) => a - b));
        // A stack holds at least two files, all of one document, in the server's order.
        for (const e of entries) {
          if (e.kind !== 'group') continue;
          expect(e.group.files.length).toBeGreaterThan(1);
          expect(new Set(e.group.files.map((f) => documentOf(f.path).key))).toEqual(new Set([e.group.key]));
          expect(e.group.files.map((f) => list.indexOf(f))).toEqual([...e.group.files.map((f) => list.indexOf(f))].sort((a, b) => a - b));
          expect(opened).not.toContain(e.group.key);
        }
      }),
      { examples: [[TOP.map((p) => file(p)), []], [[], []], [[file('Отчёт.pdf')], ['отчёт']]] },
    );
  });
});
