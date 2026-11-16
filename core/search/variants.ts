// What a person may have meant by a word of a query (spec, section 8.21): another form of it (the stem
// from the Russian dictionary of the database), the other keyboard layout, the word in Latin letters by
// the transliteration systems people type, or a Latin word back in Cyrillic. A text matches a word when
// it holds a direct variant as a piece; a fuzzy one is compared with typos by pg_trgm (search-sql.ts).
import { ALA_LC_ALT, BS_2979_ALT, GOST_16876_ALT, GOST_52290, GOST_52535, GOST_7034, GOST_779_ALT, ICAO_DOC_9303, MOSMETRO, MVD_310, MVD_782, TELEGRAM, translate, WIKIPEDIA, YANDEX_MAPS, YANDEX_MONEY, type Schema } from 'iuliia';
import type { Db } from '../db/pool.ts';

// The systems of iuliia that write plain Latin letters. Left out: those with diacritics (ščuka, mariâ)
// or a Cyrillic «ё» in the output — nobody types them in a file name — and the French one of the
// passport office (chtchouka): Russian names are not typed that way here.
export const SCHEMES: [string, Schema][] = [
  ['ICAO_DOC_9303', ICAO_DOC_9303],
  ['MVD_782', MVD_782],
  ['MVD_310', MVD_310],
  ['GOST_779_ALT', GOST_779_ALT],
  ['GOST_52535', GOST_52535],
  ['GOST_52290', GOST_52290],
  ['GOST_7034', GOST_7034],
  ['GOST_16876_ALT', GOST_16876_ALT],
  ['BS_2979_ALT', BS_2979_ALT],
  ['ALA_LC_ALT', ALA_LC_ALT],
  ['WIKIPEDIA', WIKIPEDIA],
  ['YANDEX_MAPS', YANDEX_MAPS],
  ['YANDEX_MONEY', YANDEX_MONEY],
  ['TELEGRAM', TELEGRAM],
  ['MOSMETRO', MOSMETRO],
];

// Keys of one row of the keyboard: «,.l;tn» typed in the English layout is «бюджет».
const EN_KEYS = "`qwertyuiop[]asdfghjkl;'zxcvbnm,./";
const RU_KEYS = 'ёйцукенгшщзхъфывапролджэячсмитьбю.';
const TO_RU = new Map([...EN_KEYS].map((key, i) => [key, RU_KEYS[i]!]));
const TO_EN = new Map([...RU_KEYS].map((key, i) => [key, EN_KEYS[i]!]));

// Latin letters back to Cyrillic, longest first; the first choice is the common one, the others are
// what other systems mean by the same letters (ICAO «ia» is «я», but «material» is «материал»).
const BACK: [string, string[]][] = [
  ['shch', ['щ']],
  ['shh', ['щ']],
  ['sch', ['щ', 'сч', 'ш']],
  ['tch', ['тч', 'ч']],
  ['jj', ['й']],
  ['zh', ['ж']],
  ['kh', ['х']],
  ['ch', ['ч']],
  ['sh', ['ш']],
  ['sc', ['щ', 'ск', 'сц']],
  ['tc', ['ц']],
  ['ts', ['ц', 'тс']],
  ['cz', ['ц']],
  ['yo', ['е', 'йо']],
  ['jo', ['е', 'жо', 'йо']],
  // «y» before a vowel is also how many systems write «ъ» and «ь»: «obyem» is «объём».
  ['ye', ['е', 'ые', 'ъе', 'ье']],
  ['je', ['е', 'же']],
  ['yu', ['ю']],
  ['ju', ['ю', 'жу']],
  ['iu', ['ю', 'иу']],
  ['ya', ['я']],
  ['ja', ['я', 'жа']],
  ['ia', ['я', 'иа']],
  // ICAO writes «ъ» as «ie»: «объём» is «obieem».
  ['iee', ['ъе', 'ье', 'иее']],
  ['ie', ['ие', 'ье', 'ъе', 'ъ']],
  ['a', ['а']],
  ['b', ['б']],
  ['c', ['ц', 'к']],
  ['d', ['д']],
  ['e', ['е', 'э']],
  ['f', ['ф']],
  ['g', ['г']],
  ['h', ['х']],
  ['i', ['и', 'й']],
  ['j', ['й', 'ж']],
  ['k', ['к']],
  ['l', ['л']],
  ['m', ['м']],
  ['n', ['н']],
  ['o', ['о']],
  ['p', ['п']],
  ['q', ['к']],
  ['r', ['р']],
  ['s', ['с']],
  ['t', ['т']],
  ['u', ['у']],
  ['v', ['в']],
  ['w', ['в', 'ш']],
  ['x', ['х', 'кс']],
  ['y', ['ы', 'й']],
  ['z', ['з']],
];
const VOWELS = new Set('aeiouy');

// The choices of a rule where it stands: «j» after a consonant is mostly «ж» (Telegram: «biudjet»), after
// a vowel «y» and «i» are mostly «й» («rayon», «raion»), «ia» inside a word is mostly «иа» («material»),
// «e» inside a word is never «э».
function choicesAt(latin: string, options: string[], word: string, at: number): string[] {
  const before = at > 0 ? word[at - 1]! : '';
  const end = at + latin.length >= word.length;
  if (latin.startsWith('j') && latin.length === 2 && before && !VOWELS.has(before)) return [...options].reverse();
  if ((latin === 'y' || latin === 'i') && VOWELS.has(before)) return latin === 'y' ? ['й', 'ы'] : ['и', 'й'];
  if ((latin === 'yo' || latin === 'jo') && VOWELS.has(before)) return ['йо', ...options.filter((o) => o !== 'йо')];
  if (latin === 'ia' && !end && word.slice(at - 2, at) !== 'ie') return ['иа', 'я'];
  // ICAO «ъ» before «я», «ю», «е»: «obieiavlenie», «podieezd».
  if (latin === 'ie' && VOWELS.has(word[at + 2] ?? '')) return ['ъ', ...options.filter((o) => o !== 'ъ')];
  if (latin === 'e' && at > 0) return ['е'];
  return options;
}

const MAX_CANDIDATES = 12;
const MAX_DIRECT = 24;
const FUZZY_READINGS = 3;
// Shorter words are compared without typos: «кп» would otherwise find everything.
export const MIN_FUZZY_LENGTH = 4;
const MIN_STEM_LENGTH = 3;

const CYRILLIC = /[\u0400-\u04ff]/;
const LATIN = /[a-z]/;
const WORD = /^[\p{L}\p{N}]+$/u;
const LETTER = /\p{L}/u;

export interface WordVariants {
  // The word as the search compares it: lower case, «ё» as «е».
  word: string;
  // Pieces of text that mean this word; the word itself first.
  direct: string[];
  // Words compared with typos, each at least MIN_FUZZY_LENGTH long.
  fuzzy: string[];
  // The word with two neighbouring letters swapped («договро» → «договор»): a typo that edits count as two.
  swaps: string[];
  // Words people have written that this one is a typo of (app.search_words; filled by correctionsOf).
  corrections: string[];
}

export const normalize = (text: string) => text.toLowerCase().replaceAll('ё', 'е');

function swapsOf(word: string): string[] {
  if ([...word].length < MIN_FUZZY_LENGTH) return [];
  const letters = [...word];
  const out = letters.slice(0, -1).map((_, i) => [...letters.slice(0, i), letters[i + 1], letters[i], ...letters.slice(i + 2)].join(''));
  return [...new Set(out)].filter((s) => s !== word);
}
const words = (text: string) => text.split(/\s+/).filter(Boolean);

// The query as if typed in the other layout: into Cyrillic when it has more Latin letters, otherwise into Latin.
export function switchLayout(text: string): string {
  const latin = [...text].filter((c) => LATIN.test(c)).length;
  const cyrillic = [...text].filter((c) => CYRILLIC.test(c)).length;
  const map = latin > cyrillic ? TO_RU : TO_EN;
  return [...text].map((c) => map.get(c) ?? c).join('');
}

// A Cyrillic word in Latin by every system of SCHEMES, without the quotes some put for «ъ» and «ь».
export function latinForms(word: string): string[] {
  return [...new Set(SCHEMES.map(([, schema]) => translate(word, schema).toLowerCase().replace(/['"`]/g, '')))];
}

// A Latin word in Cyrillic: the common reading first, then readings that differ in one ambiguous place,
// then in two.
export function cyrillicCandidates(word: string): string[] {
  const segments: string[][] = [];
  let i = 0;
  while (i < word.length) {
    const rule = BACK.find(([latin]) => word.startsWith(latin, i));
    if (!rule) {
      segments.push([word[i]!]);
      i += 1;
      continue;
    }
    segments.push(choicesAt(rule[0], rule[1], word, i));
    i += rule[0].length;
  }
  const primary = segments.map((s) => s[0]!);
  const ambiguous = segments.flatMap((s, at) => (s.length > 1 ? [at] : []));
  const changed = (changes: [number, string][]) => {
    const out = [...primary];
    for (const [at, choice] of changes) out[at] = choice;
    return out.join('');
  };
  const out = [primary.join('')];
  for (const at of ambiguous) for (const choice of segments[at]!.slice(1)) out.push(changed([[at, choice]]));
  for (const [n, first] of ambiguous.entries()) {
    for (const second of ambiguous.slice(n + 1)) {
      for (const a of segments[first]!.slice(1)) for (const b of segments[second]!.slice(1)) out.push(changed([[first, a], [second, b]]));
    }
  }
  return [...new Set(out)].slice(0, MAX_CANDIDATES);
}

// The variants of every word of a query; `stems` — the dictionary's stem of a Russian word, when it has one.
export function buildVariants(query: string, stems: ReadonlyMap<string, string>): WordVariants[] {
  const text = normalize(query);
  const switched = words(switchLayout(text));
  return words(text).map((word, i) => {
    const other = switched[i];
    const layout = other !== undefined && other !== word && WORD.test(other) ? other : null;
    // A word typed in the wrong layout is meant as it reads in the other one: no transliteration of it.
    const typed = [word, stems.get(word)].filter((b): b is string => b !== undefined);
    const layouts = layout === null ? [] : [layout, stems.get(layout)].filter((b): b is string => b !== undefined);
    const direct: string[] = [];
    const cyrillicOfLatin: string[] = [];
    for (const base of typed) {
      direct.push(base);
      if (CYRILLIC.test(base)) direct.push(...latinForms(base));
      else if (LATIN.test(base) && WORD.test(base)) {
        const candidates = cyrillicCandidates(base);
        cyrillicOfLatin.push(...candidates);
        direct.push(...candidates);
      }
    }
    direct.push(...layouts);
    // Latin by one system finds Latin by another through the Cyrillic it means.
    for (const candidate of cyrillicOfLatin) direct.push(...latinForms(candidate));
    const unique = [...new Set(direct)].filter((d) => d === word || d.length >= 2).slice(0, MAX_DIRECT);
    // With typos the word is compared in the other script too: by its first Latin form, or by the first
    // readings of a Latin word — the right one is often second (ICAO «kalkuliatsiia»).
    const otherScript = CYRILLIC.test(word) ? latinForms(word).slice(0, 1) : cyrillicOfLatin.slice(0, FUZZY_READINGS);
    // A number or a code («250-7», «№12») is meant exactly: typos only in words with letters.
    if (!LETTER.test(word)) return { word, direct: unique, fuzzy: [], swaps: [], corrections: [] };
    const fuzzy = [...new Set([word, layout, ...otherScript].filter((f): f is string => typeof f === 'string' && f.length >= MIN_FUZZY_LENGTH))];
    return { word, direct: unique, fuzzy, swaps: [...new Set([...swapsOf(word), ...(layout === null ? [] : swapsOf(layout))])], corrections: [] };
  });
}

// buildVariants with the stems of the Russian words from the database's dictionary (russian_stem).
export async function queryVariants(db: Db, query: string): Promise<WordVariants[]> {
  const text = normalize(query);
  const candidates = [...new Set([...words(text), ...words(switchLayout(text))])].filter((w) => CYRILLIC.test(w));
  const stems = new Map<string, string>();
  if (candidates.length > 0) {
    const { rows } = await db.query<{ word: string; stem: string | null }>(`SELECT w AS word, (ts_lexize('russian_stem', w))[1] AS stem FROM unnest($1::text[]) AS w`, [candidates]);
    for (const { word, stem } of rows) if (stem && stem !== word && stem.length >= MIN_STEM_LENGTH) stems.set(word, stem);
  }
  return buildVariants(query, stems);
}
