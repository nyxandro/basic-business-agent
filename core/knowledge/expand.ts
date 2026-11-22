// The query of the knowledge base by words, in full force (docs/specs/[20.11.2026]-knowledge-base.md, section 8; owner
// 21.11, F1): every word of a question becomes «any of» its forms, its other script and layout (the code of Ctrl+K,
// core/search/variants.ts), the words of the base it is a typo of (app.kb_words) and its synonyms — of the common
// dictionary and of the groups people added for the bases the person reads. The word itself always stays: a wrong
// correction adds candidates, never removes the right ones.
import type pg from 'pg';
import { correctionsOf } from '../search/match-sql.ts';
import { normalize, type WordVariants } from '../search/variants.ts';
import { cyrillicCode, latinCode, normText } from './chunk.ts';
import { COMMON_SYNONYMS } from './synonyms.ts';

export const VARIANTS_PER_WORD = 8;
export const VARIANTS_PER_QUERY = 60;

export interface ExpandedQuery {
  // A tsquery for to_tsquery('russian', …): the terms of every word joined by «|»; empty — nothing to look for.
  tsquery: string;
  // The question as the trigrams compare it.
  norm: string;
  // The terms by word, for the tests and the journal.
  terms: string[][];
}

// A term as tsquery takes it: letters and digits only, a phrase of several words in order.
function termOf(text: string): string | null {
  const words = normalize(text).match(/[\p{L}\p{N}]+/gu);
  if (!words || words.length === 0) return null;
  return words.length === 1 ? words[0] : `(${words.join(' <-> ')})`;
}

// Synonyms by the stem of the word: «рекламацию» finds the group of «рекламация».
async function synonymsOf(client: pg.PoolClient, words: string[], departmentIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (words.length === 0) return out;
  const groups: string[][] = [...COMMON_SYNONYMS];
  const { rows } = await client.query<{ words: string[] }>(
    `SELECT array_agg(word) AS words FROM app.kb_synonyms WHERE scope = 'org' OR department_id::text = ANY($1) GROUP BY group_id`,
    [departmentIds],
  );
  groups.push(...rows.map((r) => r.words));
  const all = [...new Set([...words, ...groups.flat()])];
  const stems = new Map((await client.query<{ w: string; stem: string | null }>(`SELECT w, (ts_lexize('russian_stem', w))[1] AS stem FROM unnest($1::text[]) AS w`, [all])).rows.map((r) => [r.w, r.stem ?? r.w]));
  const stemOf = (w: string) => stems.get(w) ?? w;
  for (const word of words) {
    const found = groups.filter((g) => g.some((member) => member === word || stemOf(member) === stemOf(word)));
    out.set(word, [...new Set(found.flat().filter((m) => m !== word))]);
  }
  return out;
}

// A question as the words of the search take it: punctuation off the words («рекламация?», «djpdhfn,» — the word
// itself), a hyphen kept only inside a word («С-21», «прайс-лист»).
export function cleanQuestion(question: string): string {
  return question
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/(^|\s)-+|-+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A code — letters with digits, «С21», «C-21», «А500С» — in both scripts and without its hyphen: the document may have
// it typed either way.
function codeForms(word: string): string[] {
  if (!/\p{N}/u.test(word) || !/\p{L}/u.test(word)) return [];
  const joined = word.replaceAll('-', '');
  return [joined, cyrillicCode(joined), latinCode(joined)];
}

export async function expandQuery(client: pg.PoolClient, variants: WordVariants[], question: string, departmentIds: string[]): Promise<ExpandedQuery> {
  const corrected = await correctionsOf(client, variants, 'app.kb_words');
  const synonyms = await synonymsOf(client, corrected.map((w) => w.word), departmentIds);
  const terms: string[][] = [];
  let total = 0;
  for (const word of corrected) {
    // The word, its code forms, its synonyms and the words it is a typo of first; its other scripts and layout fill what
    // is left. The word itself always stays, past the limit of the query too.
    const candidates = [word.word, ...codeForms(word.word), ...(synonyms.get(word.word) ?? []), ...word.corrections, ...word.direct];
    const unique = [...new Set(candidates.map(termOf).filter((t): t is string => t !== null))].slice(0, Math.max(1, Math.min(VARIANTS_PER_WORD, VARIANTS_PER_QUERY - total)));
    if (unique.length === 0) continue;
    total += unique.length;
    terms.push(unique);
  }
  // The trigrams compare a code joined, as documents mostly have it: «С-21» as «с21».
  return { tsquery: terms.flat().join(' | '), norm: normText(question.replace(/(\p{L}+)-(\p{N}+)/gu, '$1$2')).trim(), terms };
}
