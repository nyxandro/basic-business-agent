// Search over the person's own conversations and projects (spec, section 8.13). It reads Mastra's
// tables directly (mastra_threads, mastra_messages: content is JSON text with "parts"), so it lives
// in this one module and its test runs on a real database: a Mastra upgrade that changes the
// tables breaks the test, not the product silently.
import type { SearchResponse, SearchScope } from '@bba/contracts';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { listProjects, type ProjectsDeps } from '../projects/projects.ts';

export const MIN_QUERY = 2;
const MAX_RESULTS = 50;
const SNIPPET_RADIUS = 60;

function words(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

// ILIKE pattern of one word: % and _ the person typed are plain characters.
function likeOf(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// The piece of text around a match. Words already visible in the title tell nothing new, so the
// piece is centred on a word found only in the messages when there is one.
function snippetOf(body: string, title: string, terms: string[]): string {
  const text = body.replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  const titled = title.toLowerCase();
  const ordered = [...terms.filter((w) => !titled.includes(w)), ...terms.filter((w) => titled.includes(w))];
  const at = ordered.map((w) => lower.indexOf(w)).find((i) => i >= 0);
  if (at === undefined) return text.slice(0, SNIPPET_RADIUS * 2).trim();
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

interface Row {
  id: string;
  title: string | null;
  agent_id: string;
  updated: Date;
  body: string;
  project_id: string | null;
}

async function searchThreads(db: Db, userId: string, terms: string[], projectId: string | null): Promise<SearchResponse['threads']> {
  const params: unknown[] = [userId, projectId];
  // Rough pass on the raw stored text (no JSON parsing): a conversation stays a candidate only if
  // every word occurs in its title or anywhere in its messages. The exact pass below reads only the
  // text parts of the candidates' messages.
  const rough: string[] = [];
  const conditions = terms.map((w) => {
    params.push(likeOf(w));
    const n = params.length;
    rough.push(`(t.title ILIKE $${n} ESCAPE '\\' OR EXISTS (SELECT 1 FROM mastra.mastra_messages r WHERE r.thread_id = t.id AND r.content ILIKE $${n} ESCAPE '\\'))`);
    return `(own.title ILIKE $${n} ESCAPE '\\' OR COALESCE(msg.body, '') ILIKE $${n} ESCAPE '\\')`;
  });
  // Candidates go newest first through the exact pass one by one (LATERAL), and the query stops at
  // the 50th match: a common word does not make it read every conversation of the person.
  const { rows } = await db.query<Row>(
    `SELECT own.id, own.title, own.agent_id, own.updated, COALESCE(msg.body, '') AS body, own.project_id
       FROM (
         SELECT t.id, t.title, t.metadata->>'agentId' AS agent_id, t."updatedAtZ" AS updated, tp.project_id
           FROM mastra.mastra_threads t
           LEFT JOIN app.thread_projects tp ON tp.thread_id = t.id AND tp.user_id = $1
          WHERE t."resourceId" = $1
            AND COALESCE(t.metadata->>'kind', 'chat') <> 'draft'
            AND ($2::uuid IS NULL OR tp.project_id = $2::uuid)
            AND ${rough.join(' AND ')}
          ORDER BY t."updatedAtZ" DESC, t.id DESC
       ) AS own
       CROSS JOIN LATERAL (
         SELECT string_agg(part->>'text', E'\\n' ORDER BY m."createdAtZ") AS body
           FROM mastra.mastra_messages m
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN left(m.content, 1) = '{' THEN COALESCE(m.content::jsonb -> 'parts', '[]'::jsonb) ELSE '[]'::jsonb END
           ) AS part
          WHERE m.thread_id = own.id AND m.role IN ('user', 'assistant') AND part->>'type' = 'text'
       ) AS msg
      WHERE ${conditions.join(' AND ')}
      ORDER BY own.updated DESC, own.id DESC
      LIMIT ${MAX_RESULTS}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    title: r.title ?? 'Без названия',
    snippet: snippetOf(r.body, r.title ?? '', terms),
    projectId: r.project_id,
    updatedAt: r.updated.toISOString(),
  }));
}

export async function search(deps: ProjectsDeps, userId: string, query: { q: string; scope: SearchScope; projectId: string | null }): Promise<SearchResponse> {
  const terms = words(query.q);
  if (query.q.trim().length < MIN_QUERY || terms.length === 0) {
    throw appError('APP_VALIDATION_FAILED', `search query "${query.q}" is too short`, { userMessage: `Введите хотя бы ${MIN_QUERY} символа.` });
  }
  const [seen, threads] = await Promise.all([
    listProjects(deps, userId).then((list) => list.projects),
    query.scope === 'projects' ? [] : searchThreads(deps.db, userId, terms, query.projectId),
  ]);
  const projects = query.scope === 'threads' ? [] : seen;
  // A conversation whose project the person no longer sees is shown without one (spec, 8.20).
  const seenIds = new Set(seen.map((p) => p.id));
  if (query.projectId && !seenIds.has(query.projectId)) return { projects: [], threads: [] };
  return {
    threads: threads.map((th) => (th.projectId && !seenIds.has(th.projectId) ? { ...th, projectId: null } : th)),
    projects: projects
      .filter((p) => (!query.projectId || p.id === query.projectId) && terms.every((w) => p.name.toLowerCase().includes(w)))
      .map((p) => ({ id: p.id, name: p.name, threadCount: p.threadCount, shared: p.shared, ownerName: p.role === 'member' ? p.owner.name : null })),
  };
}
