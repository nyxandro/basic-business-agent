// The search of the knowledge base (docs/specs/[20.11.2026]-knowledge-base.md, section 17): one SQL — the full-text
// list by the expanded query and the list by trigrams, 30 each, joined by their places (RRF = Σ 1/(60 + place)); the
// person's access and the current version are in every list, so a fragment of another department can never come out.
// A third list — vectors of the model of meaning — is added here when it is built (owner 22.11, F4: not now).
import type { KbFragmentDto } from '@bba/contracts';
import type { Db } from '../db/pool.ts';
import { inSearch } from '../search/match-sql.ts';
import { queryVariants } from '../search/variants.ts';
import { logEvent } from '../server/log.ts';
import { cleanQuestion, expandQuery } from './expand.ts';
import { readableDepartments } from './store.ts';

export const FRAGMENTS_FOUND = 8;
export const FRAGMENT_CHARS = 1500;
const LIST_SIZE = 30;
const RRF_K = 60;
// What a sample gets over a document found as well (docs/specs/[20.11.2026]-feedback-and-value.md): less than one place of
// a list anywhere in it (1/(60+p) − 1/(61+p) ≥ 1/91² ≈ 0.00012 for the 30 places of a list), so a sample wins a tie and
// never a better match.
const EXAMPLE_BONUS = 0.00005;
// The likeness of trigrams a fragment needs to the question (as Ctrl+K starts, core/search/match-sql.ts).
const TRIGRAM_THRESHOLD = 0.3;

// `kind` — 'example': samples only (an agent making a document looks for samples of its kind first).
export async function searchKnowledge(db: Db, userId: string, question: string, documentId: string | null, kind: 'any' | 'example' = 'any'): Promise<KbFragmentDto[]> {
  const started = Date.now();
  const departments = await readableDepartments(db, userId);
  const clean = cleanQuestion(question);
  const variants = await queryVariants(db, clean);
  const found = await inSearch(db, async (c) => {
    const expanded = await expandQuery(c, variants, clean, departments);
    if (!expanded.tsquery && expanded.norm.length < 3) return [];
    await c.query(`SELECT set_config('pg_trgm.word_similarity_threshold', $1, true)`, [String(TRIGRAM_THRESHOLD)]);
    const { rows } = await c.query<{ id: string; document_id: string; version: number; title: string; kind: 'document' | 'example'; doc_type: string | null; section: string | null; page: number | null; edition: string | null; text: string }>(
      `WITH allowed AS (
         SELECT d.id, d.current_version FROM app.kb_documents d
          WHERE d.current_version IS NOT NULL AND (d.scope = 'org' OR d.department_id::text = ANY($1)) AND ($2::uuid IS NULL OR d.id = $2) AND ($5 = 'any' OR d.kind = $5)
       ),
       q AS (SELECT CASE WHEN $3 = '' THEN NULL ELSE to_tsquery('russian', $3) END AS q),
       fts AS (
         SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q.q) DESC, c.id) AS place
           FROM app.kb_chunks c JOIN allowed a ON a.id = c.document_id AND a.current_version = c.version, q
          WHERE q.q IS NOT NULL AND c.tsv @@ q.q
          ORDER BY place LIMIT ${LIST_SIZE}
       ),
       tri AS (
         SELECT c.id, row_number() OVER (ORDER BY word_similarity($4, c.norm_text) DESC, c.id) AS place
           FROM app.kb_chunks c JOIN allowed a ON a.id = c.document_id AND a.current_version = c.version
          WHERE length($4) >= 3 AND $4 <% c.norm_text
          ORDER BY place LIMIT ${LIST_SIZE}
       ),
       scored AS (SELECT id, sum(1.0 / (${RRF_K} + place)) AS score FROM (SELECT * FROM fts UNION ALL SELECT * FROM tri) x GROUP BY id)
       SELECT c.id, c.document_id, c.version, d.title, d.kind, d.doc_type, c.section, c.page, to_char(d.edition_date, 'DD.MM.YYYY') AS edition, c.text
         FROM scored s JOIN app.kb_chunks c ON c.id = s.id JOIN app.kb_documents d ON d.id = c.document_id
        ORDER BY s.score + CASE WHEN d.kind = 'example' THEN ${EXAMPLE_BONUS} ELSE 0 END DESC, c.id LIMIT ${FRAGMENTS_FOUND}`,
      [departments, documentId, expanded.tsquery, expanded.norm, kind],
    );
    return rows;
  });
  logEvent('info', 'knowledge_search', { found: found.length, ms: Date.now() - started, mode: 'words' });
  return found.map((r) => ({
    ref: `${r.document_id}#${r.id}`,
    docId: r.document_id,
    version: r.version,
    document: r.title,
    ...(r.kind === 'example' ? { example: r.doc_type ?? 'Образец' } : {}),
    section: r.section,
    page: r.page,
    edition: r.edition,
    text: [...r.text].length > FRAGMENT_CHARS ? `${[...r.text].slice(0, FRAGMENT_CHARS).join('')}…` : r.text,
  }));
}
