// Versions of one document gather into a stack in «Файлы проекта» (decision of the owner 18.11):
// «Отчёт v2.pdf», «Отчёт v3.pptx» and «Отчёт.docx» in one folder are one document. A stack stands in
// the place of its first file and opens into its files where they stand; it does not close again.
import type { ProjectFile } from '@bba/contracts';

// « v2», «_V3», «-v1.2», «(v4)», «.v5» at the end of a name; a v inside a word («Kiev2») is not one.
const VERSION_AT_END = /(?:^|[\s_\-.(])v\.?\s?(\d+(?:\.\d+)*)\)?$/i;
const SEPARATORS_AT_END = /[\s_\-.]+$/;

export interface FileDocument {
  // The folder and the name without the format and the version, in lower case.
  key: string;
  title: string;
  version: string | null;
}

export function documentOf(path: string): FileDocument {
  const slash = path.lastIndexOf('/');
  const folder = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const bare = dot > 0 ? name.slice(0, dot) : name;
  const found = VERSION_AT_END.exec(bare);
  const base = found ? bare.slice(0, found.index).replace(SEPARATORS_AT_END, '') : '';
  // «v2.pdf» alone is a name, not a version of nothing.
  const title = folder + (base || bare);
  return { key: title.toLowerCase(), title, version: base ? found![1]! : null };
}

export interface FileGroup {
  key: string;
  title: string;
  files: ProjectFile[];
  // Different versions among the files; a name without one counts as one of them.
  versions: number;
}

export type ListEntry = { kind: 'file'; file: ProjectFile } | { kind: 'group'; group: FileGroup };

// The rows of the list: a document of two files or more is a stack unless it has been opened.
export function listEntries(files: readonly ProjectFile[], opened: ReadonlySet<string>): ListEntry[] {
  const documents = files.map((f) => documentOf(f.path));
  const members = new Map<string, ProjectFile[]>();
  files.forEach((f, i) => members.set(documents[i]!.key, [...(members.get(documents[i]!.key) ?? []), f]));
  const entries: ListEntry[] = [];
  const placed = new Set<string>();
  files.forEach((f, i) => {
    const { key, title } = documents[i]!;
    const group = members.get(key)!;
    if (group.length < 2 || opened.has(key)) {
      entries.push({ kind: 'file', file: f });
      return;
    }
    if (placed.has(key)) return;
    placed.add(key);
    const versions = new Set(group.map((m) => documentOf(m.path).version)).size;
    entries.push({ kind: 'group', group: { key, title, files: group, versions } });
  });
  return entries;
}
