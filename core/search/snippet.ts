// The piece of text shown under a found conversation in «Поиск» (spec, section 8.13): ±60 characters
// of what the person saw in the chat around a match. The person's own text is shown as typed; an
// agent's answer as the chat draws its Markdown (visible-text.ts).
import { typoPieces } from './match-sql.ts';
import { normalize, type WordVariants } from './variants.ts';
import { visibleText } from './visible-text.ts';

export const SNIPPET_RADIUS = 60;
// Raw characters on each side of a match that are parsed, rounded out to whole lines: parsing a whole
// answer of 20 000 characters takes ~23 ms, for 50 results more than a second.
const CONTEXT = 300;
// A line reaching further than this past the context is cut mid-line.
const MAX_LINE_REACH = 1500;
// Answers parsed per word when the word turns out to be only in markup (a link's address); then the
// next word is tried, and at last the conversation's first words are shown.
const MAX_PARSES_PER_WORD = 2;

export interface MessageText {
  role: 'user' | 'assistant';
  text: string;
}

interface Visible {
  text: string;
  // Cut from a longer text before or after.
  before: boolean;
  after: boolean;
}

// The chat parser's own rules (@copilotkit/markdown): a fence opens with ``` or ~~~ (3 or more) after
// any indent and closes with a line of the same marker alone, at least as long; a table is a row with
// a divider under it, and goes on while lines look like rows.
const FENCE_OPEN = /^(`{3,}|~{3,})/;
const isRow = (line: string) => line.includes('|') && /\S/.test(line.replace(/\|/g, ''));
const isDivider = (line: string) => {
  const trimmed = line.trim();
  const cells = (trimmed.endsWith('|') ? trimmed.slice(0, -1) : trimmed).replace(/^\|/, '').split('|');
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
};

// The opening of a block that runs across the window's first line: the fence line of a code block, or
// the header and divider of a table. Without it the window is read wrong: code after a blank line in
// it as Markdown, the code's closing fence as an opening one, table rows as text with pipes.
function blockOpenAt(lines: string[], first: number): string | null {
  let fence: { marker: string; length: number; line: string } | null = null;
  let table: string | null = null;
  for (let i = 0; i < first; i++) {
    const line = lines[i]!;
    if (fence) {
      const trimmed = line.trim();
      if (trimmed.length >= fence.length && new RegExp(`^\\${fence.marker}+$`).test(trimmed)) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line.trimStart());
    if (open) {
      fence = { marker: open[1]![0]!, length: open[1]!.length, line };
      table = null;
      continue;
    }
    if (table !== null && isRow(line)) continue;
    table = null;
    const next = lines[i + 1];
    if (i + 1 < first && next !== undefined && isRow(line) && isDivider(next)) {
      table = `${line}\n${next}`;
      i += 1;
    }
  }
  return fence ? fence.line : table;
}

// What the person saw of an answer around a raw position: whole lines around it, read with the block
// they continue.
function visibleOfAnswer(text: string, at: number, length: number): Visible {
  const lines = text.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const lineOf = (pos: number) => {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1]! <= pos) i += 1;
    return i;
  };
  let first = lineOf(Math.max(0, at - CONTEXT));
  const last = lineOf(Math.min(text.length, at + length + CONTEXT));
  // A window opening on a table's divider takes its header line too.
  if (first > 0 && isDivider(lines[first]!) && isRow(lines[first - 1]!)) first -= 1;
  const from = Math.max(starts[first]!, at - CONTEXT - MAX_LINE_REACH);
  const to = Math.min(starts[last]! + lines[last]!.length, at + length + CONTEXT + MAX_LINE_REACH);
  const opening = blockOpenAt(lines, first);
  const piece = text.slice(from, to);
  let seen = visibleText(opening === null ? piece : `${opening}\n${piece}`);
  // The opening's own words (a table's header) are not part of the window.
  const head = opening === null ? '' : visibleText(opening);
  if (head && seen.startsWith(head)) seen = seen.slice(head.length).trimStart();
  return { text: seen, before: from > 0, after: to < text.length };
}

const isLowSurrogate = (text: string, i: number) => {
  const code = text.charCodeAt(i);
  return code >= 0xdc00 && code <= 0xdfff;
};

// `back` characters before `at` and `ahead` from it; an emoji on an edge is kept whole.
function cut(visible: Visible, at: number, back: number, ahead: number): string {
  let start = Math.max(0, at - back);
  let end = Math.min(visible.text.length, at + ahead);
  if (start > 0 && isLowSurrogate(visible.text, start)) start -= 1;
  if (end < visible.text.length && isLowSurrogate(visible.text, end)) end += 1;
  return `${visible.before || start > 0 ? '…' : ''}${visible.text.slice(start, end).trim()}${visible.after || end < visible.text.length ? '…' : ''}`;
}

const plain = (text: string): Visible => ({ text: text.replace(/\s+/g, ' ').trim(), before: false, after: false });

// Where a word of the query is in a text: the first of the pieces the search found it by — the word, its
// stem, Latin, the other layout, a word of the dictionary its typo means, two letters swapped (match-sql.ts).
function locate(text: string, word: WordVariants): { at: number; length: number } | null {
  const normal = normalize(text);
  let best: { at: number; length: number } | null = null;
  for (const piece of [...word.direct, ...typoPieces(word)]) {
    const at = normal.indexOf(piece);
    if (at >= 0 && (best === null || at < best.at)) best = { at, length: piece.length };
  }
  return best;
}

// `messages` are the conversation's text parts holding a word, in order; `opening` is its first words
// (the person's first message), shown when the words are only in the title or in markup. Words
// already visible in the title tell nothing new, so the piece is centred on a word found only in the
// messages when there is one.
export function snippetOf(messages: MessageText[], opening: string | null, title: string, words: WordVariants[]): string {
  const titled = (word: WordVariants) => locate(title, word) !== null;
  const ordered = [...words.filter((w) => !titled(w)), ...words.filter(titled)];
  for (const word of ordered) {
    let parses = 0;
    for (const message of messages) {
      const raw = locate(message.text, word);
      if (raw === null) continue;
      if (message.role === 'assistant' && ++parses > MAX_PARSES_PER_WORD) break;
      const visible = message.role === 'user' ? plain(message.text) : visibleOfAnswer(message.text, raw.at, raw.length);
      const found = locate(visible.text, word);
      if (found !== null) return cut(visible, found.at, SNIPPET_RADIUS, SNIPPET_RADIUS);
    }
  }
  return opening === null ? '' : cut(plain(opening), 0, 0, 2 * SNIPPET_RADIUS);
}
