// Search over the person's own conversations and projects (spec, section 8.13). It reads Mastra's
// tables directly (mastra_threads, mastra_messages: content is JSON text with "parts"), so it lives
// in this one module and its test runs on a real database: a Mastra upgrade that changes the
// tables breaks the test, not the product silently.
import type { SearchResponse, SearchScope } from '@bba/contracts';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { listProjects, type ProjectsDeps } from '../projects/projects.ts';
import { snippetOf, type MessageText } from './snippet.ts';

export const MIN_QUERY = 2;
const MAX_RESULTS = 50;

function words(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

// ILIKE pattern of one word: % and _ the person typed are plain characters.
function likeOf(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

interface Row {
  id: string;
  title: string | null;
  agent_id: string;
  updated: Date;
  // Text parts in order, with who wrote them: the piece of text shows an answer without Markdown.
  messages: MessageText[];
  project_id: string | null;
}

async function searchThreads(db: Db, userId: string, terms: string[]): Promise<SearchResponse['threads']> {
  const params: unknown[] = [userId];
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
    `SELECT own.id, own.title, own.agent_id, own.updated, COALESCE(msg.messages, '[]'::jsonb) AS messages, own.project_id
       FROM (
         SELECT t.id, t.title, t.metadata->>'agentId' AS agent_id, t."updatedAtZ" AS updated, tp.project_id
           FROM mastra.mastra_threads t
           LEFT JOIN app.thread_projects tp ON tp.thread_id = t.id AND tp.user_id = $1
          WHERE t."resourceId" = $1
            AND COALESCE(t.metadata->>'kind', 'chat') <> 'draft'
            AND ${rough.join(' AND ')}
          ORDER BY t."updatedAtZ" DESC, t.id DESC
       ) AS own
       CROSS JOIN LATERAL (
         SELECT string_agg(part->>'text', E'\\n' ORDER BY m."createdAtZ") AS body,
                jsonb_agg(jsonb_build_object('role', m.role, 'text', part->>'text') ORDER BY m."createdAtZ") AS messages
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
    snippet: snippetOf(r.messages, r.title ?? '', terms),
    projectId: r.project_id,
    updatedAt: r.updated.toISOString(),
  }));
}

export async function search(deps: ProjectsDeps, userId: string, query: { q: string; scope: SearchScope }): Promise<SearchResponse> {
  const terms = words(query.q);
  if (query.q.trim().length < MIN_QUERY || terms.length === 0) {
    throw appError('APP_VALIDATION_FAILED', `search query "${query.q}" is too short`, { userMessage: `Введите хотя бы ${MIN_QUERY} символа.` });
  }
  const [seen, threads] = await Promise.all([
    listProjects(deps, userId).then((list) => list.projects),
    query.scope === 'projects' ? [] : searchThreads(deps.db, userId, terms),
  ]);
  const projects = query.scope === 'threads' ? [] : seen;
  // A conversation whose project the person no longer sees is shown without one (spec, 8.20).
  const seenIds = new Set(seen.map((p) => p.id));
  return {
    threads: threads.map((th) => (th.projectId && !seenIds.has(th.projectId) ? { ...th, projectId: null } : th)),
    projects: projects
      .filter((p) => terms.every((w) => p.name.toLowerCase().includes(w)))
      .map((p) => ({ id: p.id, name: p.name, threadCount: p.threadCount, shared: p.shared, ownerName: p.role === 'member' ? p.owner.name : null })),
  };
}
