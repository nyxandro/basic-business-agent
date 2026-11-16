// Conditions of a word of the query on a text in SQL (spec, section 8.21). Direct: the text holds a variant
// of the word as a piece (ILIKE; each piece its own condition, so the trigram index serves each). With a
// typo, in a message: it holds a word of the dictionary the typo means, or the word with two neighbouring
// letters swapped — pieces again, through the same index. With a typo, in a title or a name (short, a few
// hundred or thousand): pg_trgm picks those alike and levenshtein keeps those with a word within the
// allowed edits. The expression is lower case, «ё» as «е».
import type pg from 'pg';
import type { Db } from '../db/pool.ts';
import type { WordVariants } from './variants.ts';

// The likeness from which pg_trgm gives a word or a name as a candidate for a typo. Measured 16.11 on 283
// typos of 60 business words: below 0.3 no typo within the allowed edits is lost; the usual 0.6 lost most.
export const TYPO_CANDIDATE_THRESHOLD = 0.3;
// Edits allowed in a word: one for 4–7 letters, two for longer (shorter words get none, variants.ts).
const LONG_WORD = 8;
export const allowedEdits = (word: string) => ([...word].length >= LONG_WORD ? 2 : 1);

// Characters of a word in a normalized text: what lies between them splits the text into words.
const NOT_WORD = `'[^0-9a-zа-я]+'`;

// ILIKE pattern of a piece: % and _ the person typed are plain characters.
export function likeOf(piece: string): string {
  return `%${piece.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// The parameters of one statement: each value gets its $n.
export class SqlParams {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export const normalizedSql = (expr: string) => `replace(lower(coalesce(${expr}, '')), 'ё', 'е')`;

// A regular expression of a piece at the start of a word: what is not a letter or a digit before it, or nothing.
export function startOf(piece: string): string {
  return `(^|[^0-9a-zа-я])${piece.replace(/[\\^$.|?*+()[\]{}]/g, (c) => `\\${c}`)}`;
}

export function directCondition(expr: string, word: WordVariants, params: SqlParams): string {
  const anywhere = word.direct.map((piece) => `${expr} ILIKE ${params.add(likeOf(piece))}`);
  const atStart = word.starts.map((piece) => `${expr} ~ ${params.add(startOf(piece))}`);
  return `(${[...anywhere, ...atStart].join(' OR ')})`;
}

// A typo in a message: the words of the dictionary it means, or two neighbouring letters swapped.
export function typoPieces(word: WordVariants): string[] {
  return [...new Set([...word.corrections, ...word.swaps])].filter((piece) => !word.direct.includes(piece));
}

export function piecesCondition(expr: string, pieces: string[], params: SqlParams): string {
  return `(${pieces.map((piece) => `${expr} ILIKE ${params.add(likeOf(piece))}`).join(' OR ')})`;
}

// A typo in a title or a name; null when the word is too short for typos.
export function typoCondition(expr: string, word: WordVariants, params: SqlParams): string | null {
  const near = word.fuzzy.map((fuzzy) => {
    const f = `${params.add(fuzzy)}::text`;
    const k = `${params.add(allowedEdits(fuzzy))}::int`;
    // The whole word, or its start as long as the typed word (one letter longer: «дговор» → «договору»).
    const close = ['tw.w', `left(tw.w, length(${f}))`, `left(tw.w, length(${f}) + 1)`].map((w) => `levenshtein_less_equal(${w}, ${f}, ${k}) <= ${k}`).join(' OR ');
    return `(${f} <% ${expr} AND EXISTS (SELECT 1 FROM regexp_split_to_table(${expr}, ${NOT_WORD}) AS tw(w) WHERE tw.w <> '' AND (${close})))`;
  });
  const swapped = word.swaps.map((swap) => `${expr} ILIKE ${params.add(likeOf(swap))}`);
  const all = [...near, ...swapped];
  return all.length === 0 ? null : `(${all.join(' OR ')})`;
}

// Most words of the dictionary a typo stands for: the closest ones (by likeness) are kept.
const MAX_CORRECTIONS = 20;

// The words of the dictionary within the allowed edits of a word with a typo — of the whole word, or of
// its start as long as the typed word (one letter longer: «дговор» → «договору»).
export async function correctionsOf(client: pg.PoolClient, words: WordVariants[]): Promise<WordVariants[]> {
  return Promise.all(
    words.map(async (word) => {
      if (word.fuzzy.length === 0) return word;
      const params = new SqlParams();
      const near = word.fuzzy.map((fuzzy) => {
        const f = `${params.add(fuzzy)}::text`;
        const k = `${params.add(allowedEdits(fuzzy))}::int`;
        const close = ['s.word', `left(s.word, length(${f}))`, `left(s.word, length(${f}) + 1)`].map((w) => `levenshtein_less_equal(${w}, ${f}, ${k}) <= ${k}`).join(' OR ');
        return { alike: `${f} <% s.word`, close: `(${f} <% s.word AND (${close}))`, f };
      });
      const { rows } = await client.query<{ word: string }>(
        `SELECT s.word FROM app.search_words s
          WHERE (${near.map((n) => n.alike).join(' OR ')}) AND (${near.map((n) => n.close).join(' OR ')})
          ORDER BY greatest(${near.map((n) => `word_similarity(${n.f}, s.word)`).join(', ')}) DESC, s.word
          LIMIT ${MAX_CORRECTIONS}`,
        params.values,
      );
      return { ...word, corrections: rows.map((r) => r.word) };
    }),
  );
}

// A search runs read-only with its own likeness threshold for typo candidates.
export async function inSearch<T>(db: Db, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL pg_trgm.word_similarity_threshold = ${TYPO_CANDIDATE_THRESHOLD}`);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Which of `names` match every word, and whether all of them directly: for project names and file names,
// a few hundred or thousand short strings — no index needed. With `enough`, typos are looked for only when
// fewer are found directly: they rank below and would not make the list.
export async function matchNames(client: pg.PoolClient, names: string[], words: WordVariants[], enough = Infinity): Promise<{ index: number; direct: boolean }[]> {
  if (names.length === 0) return [];
  const direct = await namesBy(client, names, words, false);
  if (direct.length >= enough) return direct;
  return namesBy(client, names, words, true);
}

async function namesBy(client: pg.PoolClient, names: string[], words: WordVariants[], typos: boolean): Promise<{ index: number; direct: boolean }[]> {
  const params = new SqlParams();
  const list = params.add(names);
  const name = 'x.name';
  const directs = words.map((w) => directCondition(name, w, params));
  const each = words.map((w, i) => {
    const typo = typos ? typoCondition(name, w, params) : null;
    return typo === null ? directs[i]! : `(${directs[i]} OR ${typo})`;
  });
  const { rows } = await client.query<{ index: number; direct: boolean }>(
    `SELECT n.i::int - 1 AS index, (${directs.join(' AND ')}) AS direct
       FROM unnest(${list}::text[]) WITH ORDINALITY AS n(raw, i)
       CROSS JOIN LATERAL (SELECT ${normalizedSql('n.raw')} AS name) AS x
      WHERE ${each.join(' AND ')}
      ORDER BY n.i`,
    params.values,
  );
  return rows;
}
