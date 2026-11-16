// What of a text the search found, for the window of «Поиск» to mark (spec, section 8.21): the pieces it
// was found by — the word, its stem, Latin, the other layout (match-sql.ts, directCondition). With a typo
// the database goes by different things in a message and in a name, and so do the marks: in a message —
// the words of the dictionary the typo means and two letters swapped (typoPieces); in a name — a word
// within the allowed edits and two letters swapped (typoCondition). Typo marks are only for what was
// found with a typo: for the rest they would light up words the search did not go by.
import type { TextMarks } from '@bba/contracts';
import { allowedEdits, typoPieces } from './match-sql.ts';
import { normalize, type WordVariants } from './variants.ts';

const WORD_CHARS = /[0-9a-zа-я]+/g;
const escape = (piece: string) => piece.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');

// The text as the search compares it, letter for letter: a letter whose lower case is longer (İ) stays
// as it is, so places in it are places in the text.
function comparable(text: string): string {
  const whole = normalize(text);
  if (whole.length === text.length) return whole;
  return Array.from(text, (c) => {
    const n = normalize(c);
    return n.length === c.length ? n : c;
  }).join('');
}

// Edits between two words (insert, delete, replace), by letters; enough to stop past `limit`.
function edits(a: string, b: string, limit: number): number {
  const x = [...a];
  const y = [...b];
  if (Math.abs(x.length - y.length) > limit) return limit + 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[y.length]!;
}

// A word of the text close to a typed word: the whole word, or its start as long as the typed one or a
// letter longer — the same three the database compares (match-sql.ts, typoCondition).
function closeTo(token: string, fuzzy: string): boolean {
  const letters = [...token];
  const length = [...fuzzy].length;
  const limit = allowedEdits(fuzzy);
  return [token, letters.slice(0, length).join(''), letters.slice(0, length + 1).join('')].some((w) => edits(w, fuzzy, limit) <= limit);
}

function* occurrences(text: string, piece: string): Generator<[number, number]> {
  if (!piece) return;
  for (let at = text.indexOf(piece); at >= 0; at = text.indexOf(piece, at + 1)) yield [at, at + piece.length];
}

// How the thing was found: directly, or with a typo in a message or in a name.
export type FoundBy = 'direct' | 'message-typo' | 'name-typo';

export function marksOf(text: string, words: readonly WordVariants[], by: FoundBy): TextMarks {
  const normal = comparable(text);
  const found: [number, number][] = [];
  for (const word of words) {
    const typoInText = by === 'message-typo' ? typoPieces(word) : by === 'name-typo' ? word.swaps : [];
    for (const piece of [...word.direct, ...typoInText]) found.push(...occurrences(normal, piece));
    // A short piece only at the start of a word, as the search takes it (match-sql.ts, startOf).
    for (const piece of word.starts) {
      for (const m of normal.matchAll(new RegExp(`(?<![0-9a-zа-я])${escape(piece)}`, 'g'))) found.push([m.index, m.index + piece.length]);
    }
    if (by !== 'name-typo') continue;
    for (const m of normal.matchAll(WORD_CHARS)) {
      if (word.fuzzy.some((fuzzy) => closeTo(m[0], fuzzy))) found.push([m.index, m.index + m[0].length]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const marks: TextMarks = [];
  for (const [from, to] of found) {
    const last = marks.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else marks.push([from, to]);
  }
  return marks;
}
