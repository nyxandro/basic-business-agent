// The fragments of a document of the knowledge base (docs/specs/[20.11.2026]-knowledge-base.md, section 8): the agent
// finds and cites a fragment, so each is a piece that makes sense alone, knows where it is and is never longer than what
// the agent is shown (FRAGMENT_CHARS of search.ts).
// - Word, text, letters (Markdown from core/doctext): by headings — the section is the chain of the last two
//   headings — and a long section by paragraphs up to ~1 000 characters, the last paragraph repeated in the next piece;
//   a paragraph longer than that by lines, then sentences, then words;
// - PDF: by pages («— стр. N —» from core/doctext), a long page the same way;
// - slides: by slides («<!-- Slide number: N -->» of the skill pptx), the number as the page, the title as the section,
//   the notes inside;
// - Excel and CSV: by up to 40 rows that fit in ~1 000 characters, with the header row and the sheet's name.
import type { DocKind } from '../doctext/extract.ts';

export const CHUNK_CHARS = 1000;
export const SHEET_ROWS = 40;

export interface Chunk {
  ord: number;
  section: string | null;
  page: number | null;
  text: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;
const PAGE = /^— стр\. (\d+)(?: —|: .+ —)$/;
const SLIDE = /^<!-- Slide number: (\d+) -->$/;
const NOTES = /^#{1,6}\s+Notes:\s*$/;

// Words of a line longer than the limit, cut at the last space before it (a «word» longer than that — at the limit).
function byWords(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > CHUNK_CHARS) {
    const space = rest.lastIndexOf(' ', CHUNK_CHARS);
    const at = space > CHUNK_CHARS / 2 ? space : CHUNK_CHARS;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest !== '') out.push(rest);
  return out;
}

// Parts joined while they fit in the limit; `separator` — what stood between them.
function joinUpTo(parts: string[], separator: string): string[] {
  const out: string[] = [];
  let piece = '';
  for (const part of parts) {
    if (piece !== '' && piece.length + separator.length + part.length > CHUNK_CHARS) {
      out.push(piece);
      piece = '';
    }
    piece = piece === '' ? part : `${piece}${separator}${part}`;
  }
  if (piece !== '') out.push(piece);
  return out;
}

// A paragraph longer than the limit: by its lines, a long line by its sentences, a long sentence by its words.
export function splitLong(paragraph: string): string[] {
  if (paragraph.length <= CHUNK_CHARS) return [paragraph];
  const lines = paragraph.split('\n').flatMap((line) => {
    if (line.length <= CHUNK_CHARS) return [line];
    return joinUpTo(line.split(/(?<=[.!?…;])\s+/).flatMap(byWords), ' ');
  });
  return joinUpTo(lines, '\n');
}

// Paragraphs packed into pieces up to the limit; a piece after the first starts with the last paragraph of the one
// before when it is short, so a rule cut between two pieces is whole in one of them.
const SEPARATOR = '\n\n';
function pack(paragraphs: string[]): string[] {
  const out: string[] = [];
  let piece: string[] = [];
  const sizeOf = (parts: string[]) => parts.reduce((n, x) => n + x.length, 0) + SEPARATOR.length * Math.max(0, parts.length - 1);
  for (const p of paragraphs.flatMap(splitLong)) {
    if (piece.length > 0 && sizeOf([...piece, p]) > CHUNK_CHARS) {
      out.push(piece.join(SEPARATOR));
      const last = piece.at(-1)!;
      piece = last.length < CHUNK_CHARS / 4 ? [last] : [];
    }
    piece.push(p);
  }
  if (piece.length > 0) out.push(piece.join(SEPARATOR));
  return out;
}

// The heading put before each piece of its section: no longer than this.
const HEADING_IN_TEXT = 200;

const paragraphsOf = (lines: string[]) =>
  lines
    .join('\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');

function byHeadings(text: string): Omit<Chunk, 'ord'>[] {
  const out: Omit<Chunk, 'ord'>[] = [];
  const path: string[] = [];
  let lines: string[] = [];
  const flush = () => {
    const section = path.filter(Boolean).slice(-2).join(' › ') || null;
    // The heading goes with every piece of its section: «срок возврата» finds the section «Сроки возврата».
    const heading = path.filter(Boolean).at(-1)?.slice(0, HEADING_IN_TEXT);
    for (const piece of pack(paragraphsOf(lines))) out.push({ section, page: null, text: heading ? `${heading}\n\n${piece}` : piece });
    lines = [];
  };
  for (const line of text.split('\n')) {
    const heading = HEADING.exec(line);
    if (!heading) {
      lines.push(line);
      continue;
    }
    flush();
    const level = heading[1]!.length;
    path.splice(level - 1, path.length, heading[2]!.replace(/\*\*/g, '').trim());
  }
  flush();
  return out;
}

function byPages(text: string): Omit<Chunk, 'ord'>[] {
  const out: Omit<Chunk, 'ord'>[] = [];
  let page: number | null = null;
  let lines: string[] = [];
  const flush = () => {
    for (const piece of pack(paragraphsOf(lines))) out.push({ section: null, page, text: piece });
    lines = [];
  };
  for (const line of text.split('\n')) {
    const marker = PAGE.exec(line.trim());
    if (!marker) {
      lines.push(line);
      continue;
    }
    flush();
    page = Number(marker[1]);
    // A page without text is named by its marker: nothing to find on it.
    if (line.includes(':')) page = null;
  }
  flush();
  return out;
}

function bySlides(text: string): Omit<Chunk, 'ord'>[] {
  const out: Omit<Chunk, 'ord'>[] = [];
  let page: number | null = null;
  let lines: string[] = [];
  const flush = () => {
    const title = lines.map((l) => HEADING.exec(l)).find((h) => h && !NOTES.test(h[0]))?.[2]?.trim() ?? null;
    // The notes stay with their slide: «Заметки:» instead of a heading of their own.
    const body = lines.map((l) => (NOTES.test(l.trim()) ? 'Заметки:' : l.replace(HEADING, '$2')));
    for (const piece of pack(paragraphsOf(body))) out.push({ section: title, page, text: piece });
    lines = [];
  };
  for (const line of text.split('\n')) {
    const marker = SLIDE.exec(line.trim());
    if (!marker) {
      lines.push(line);
      continue;
    }
    flush();
    page = Number(marker[1]);
  }
  flush();
  return out;
}

function bySheets(text: string): Omit<Chunk, 'ord'>[] {
  const out: Omit<Chunk, 'ord'>[] = [];
  const blocks = text.split(/\n(?=## )/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const heading = HEADING.exec(lines[0] ?? '');
    const sheet = heading ? heading[2]! : null;
    const rows = (heading ? lines.slice(1) : lines).filter((l) => l.trim() !== '');
    if (rows.length === 0) continue;
    const [header, ...data] = rows;
    // A header longer than half a piece goes alone; the rows are not given it.
    const head = header!.length <= CHUNK_CHARS / 2 ? header! : null;
    if (data.length === 0 || head === null) {
      for (const piece of splitLong(header!)) out.push({ section: sheet, page: null, text: piece });
      if (head !== null) continue;
    }
    let piece: string[] = [];
    let size = head?.length ?? 0;
    const flush = () => {
      if (piece.length > 0) out.push({ section: sheet, page: null, text: [...(head ? [head] : []), ...piece].join('\n') });
      piece = [];
      size = head?.length ?? 0;
    };
    for (const row of data.flatMap((r) => (r.length > CHUNK_CHARS / 2 ? byWords(r) : [r]))) {
      if (piece.length >= SHEET_ROWS || (piece.length > 0 && size + 1 + row.length > CHUNK_CHARS)) flush();
      piece.push(row);
      size += 1 + row.length;
    }
    flush();
  }
  return out;
}

export function chunksOf(kind: DocKind, text: string): Chunk[] {
  const pieces = kind === 'pdf' ? byPages(text) : kind === 'sheet' ? bySheets(text) : kind === 'slides' ? bySlides(text) : byHeadings(text);
  return pieces.filter((p) => p.text.trim() !== '').map((p, ord) => ({ ...p, ord }));
}

// Letters of Latin that look like Cyrillic ones: a code typed in either script («C21», «С21») is the same code.
const LOOKALIKE: Record<string, string> = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };
const CODE = /[\p{L}\p{N}]*\p{N}[\p{L}\p{N}]*/gu;

// A code (letters with digits) in the lookalike Cyrillic letters.
export const cyrillicCode = (code: string) => [...code].map((ch) => LOOKALIKE[ch] ?? ch).join('');
export const latinCode = (code: string) => {
  const back = new Map(Object.entries(LOOKALIKE).map(([l, c]) => [c, l]));
  return [...code].map((ch) => back.get(ch) ?? ch).join('');
};

// Lower case, «ё» as «е», codes in Cyrillic: what the trigrams compare.
export const normText = (text: string) =>
  text
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(CODE, (code) => (/\p{L}/u.test(code) ? cyrillicCode(code) : code));
