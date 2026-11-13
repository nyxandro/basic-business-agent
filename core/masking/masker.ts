// Reversible masking within one conversation (spec, section 8.11): a value always gets the same
// placeholder in its thread ("[ПОЧТА_1]"), and placeholders turn back into the real values.
import { createHash } from 'node:crypto';
import type { MaskingKind } from '../config/schemas.ts';
import type { Db } from '../db/pool.ts';
import { inTransaction } from '../db/pool.ts';
import { detect, PLACEHOLDER_NAMES } from './detect.ts';

const NAME_TO_KIND = new Map(Object.entries(PLACEHOLDER_NAMES).map(([kind, name]) => [name, kind as MaskingKind]));
const PLACEHOLDER = new RegExp(`\\[(${Object.values(PLACEHOLDER_NAMES).join('|')})_(\\d+)\\]`, 'g');
const LONGEST_PLACEHOLDER = Math.max(...Object.values(PLACEHOLDER_NAMES).map((n) => n.length)) + 8;

export interface ThreadMasker {
  mask(text: string): Promise<string>;
  unmask(text: string): string;
  unknownPlaceholders(text: string): string[];
}

function hashValue(kind: MaskingKind, value: string): string {
  return createHash('sha256').update(`${kind}:${value}`).digest('hex');
}

// True when `tail` could still grow into a placeholder: used to hold back the end of a streamed chunk.
export function isPlaceholderPrefix(tail: string): boolean {
  if (!tail.startsWith('[') || tail.length > LONGEST_PLACEHOLDER) return false;
  return Object.values(PLACEHOLDER_NAMES).some((name) => {
    const head = `[${name}_`;
    return head.startsWith(tail) || (tail.startsWith(head) && /^\d*$/.test(tail.slice(head.length)));
  });
}

export async function createThreadMasker(db: Db, threadId: string, kinds: ReadonlySet<MaskingKind>): Promise<ThreadMasker> {
  const toPlaceholder = new Map<string, string>(); // value hash -> placeholder
  const toValue = new Map<string, string>(); // placeholder -> value
  const { rows } = await db.query<{ placeholder: string; value_hash: string; value: string }>(
    'SELECT placeholder, value_hash, value FROM app.masking_map WHERE thread_id = $1',
    [threadId],
  );
  for (const r of rows) {
    toPlaceholder.set(r.value_hash, r.placeholder);
    toValue.set(r.placeholder, r.value);
  }

  async function assign(kind: MaskingKind, value: string): Promise<string> {
    const hash = hashValue(kind, value);
    const known = toPlaceholder.get(hash);
    if (known) return known;
    // Numbering per kind and thread is serialised, so parallel turns never reuse a number.
    const placeholder = await inTransaction(db, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('mask:' || $1))", [threadId]);
      const existing = await c.query<{ placeholder: string }>('SELECT placeholder FROM app.masking_map WHERE thread_id = $1 AND value_hash = $2', [threadId, hash]);
      if (existing.rows[0]) return existing.rows[0].placeholder;
      const { rows: count } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM app.masking_map WHERE thread_id = $1 AND kind = $2', [threadId, kind]);
      const next = `[${PLACEHOLDER_NAMES[kind]}_${(count[0]?.n ?? 0) + 1}]`;
      await c.query('INSERT INTO app.masking_map (thread_id, kind, placeholder, value_hash, value) VALUES ($1, $2, $3, $4, $5)', [threadId, kind, next, hash, value]);
      return next;
    });
    toPlaceholder.set(hash, placeholder);
    toValue.set(placeholder, value);
    return placeholder;
  }

  return {
    async mask(text) {
      const found = detect(text, kinds);
      if (found.length === 0) return text;
      let out = '';
      let cursor = 0;
      for (const d of found) {
        out += text.slice(cursor, d.start) + (await assign(d.kind, d.value));
        cursor = d.end;
      }
      return out + text.slice(cursor);
    },
    unmask(text) {
      return text.replace(PLACEHOLDER, (ph) => toValue.get(ph) ?? ph);
    },
    unknownPlaceholders(text) {
      return [...text.matchAll(PLACEHOLDER)].map((m) => m[0]).filter((ph) => !toValue.has(ph) && NAME_TO_KIND.has(ph.slice(1, ph.lastIndexOf('_'))));
    },
  };
}
