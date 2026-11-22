// The fragments of a document of the knowledge base (docs/specs/[20.11.2026]-knowledge-base.md, section 8): the agent
// finds and cites a fragment, so each is a piece that makes sense alone and knows where it is.
// - Word, text, slides, letters (Markdown from core/doctext): by headings — the section is the chain of the last two
//   headings — and a long section by paragraphs up to ~1 000 characters, the last paragraph repeated in the next piece;
// - PDF: by pages («— стр. N —» from core/doctext), a long page by paragraphs;
// - Excel and CSV: by 40 rows with the header row and the sheet's name.
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

// Paragraphs packed into pieces up to the limit; a piece after the first starts with the last paragraph of the one
// before, so a rule cut between two pieces is whole in one of them.
function pack(paragraphs: string[]): string[] {
  const out: string[] = [];
  let piece: string[] = [];
  let size = 0;
  for (const p of paragraphs) {
    if (size > 0 && size + p.length > CHUNK_CHARS) {
      out.push(piece.join('\n\n'));
      const last = piece.at(-1)!;
      piece = last.length < CHUNK_CHARS / 2 ? [last] : [];
      size = piece.reduce((n, x) => n + x.length, 0);
    }
    piece.push(p);
    size += p.length;
  }
  if (piece.length > 0) out.push(piece.join('\n\n'));
  return out;
}

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
    const heading = path.filter(Boolean).at(-1);
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
    if (data.length === 0) {
      out.push({ section: sheet, page: null, text: header! });
      continue;
    }
    for (let i = 0; i < data.length; i += SHEET_ROWS) out.push({ section: sheet, page: null, text: [header!, ...data.slice(i, i + SHEET_ROWS)].join('\n') });
  }
  return out;
}

export function chunksOf(kind: DocKind, text: string): Chunk[] {
  const pieces = kind === 'pdf' ? byPages(text) : kind === 'sheet' ? bySheets(text) : byHeadings(text);
  return pieces.filter((p) => p.text.trim() !== '').map((p, ord) => ({ ...p, ord }));
}

// Lower case, «ё» as «е»: what the trigrams compare.
export const normText = (text: string) => text.toLowerCase().replaceAll('ё', 'е');
