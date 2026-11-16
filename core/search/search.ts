// Search over the person's own conversations and projects (spec, section 8.13). It reads Mastra's
// tables directly (mastra_threads, mastra_messages: content is JSON text with "parts"), so it lives
// in this one module and its test runs on a real database: a Mastra upgrade that changes the
// tables breaks the test, not the product silently.
import type { SearchResponse, SearchScope } from '@bba/contracts';
import type pg from 'pg';
import { appError } from '../errors/catalog.ts';
import { listProjects, type ProjectsDeps } from '../projects/projects.ts';
import { correctionsOf, directCondition, inSearch, matchNames, normalizedSql, piecesCondition, SqlParams, typoCondition, typoPieces } from './match-sql.ts';
import { searchFiles } from './files.ts';
import { snippetOf, type MessageText } from './snippet.ts';
import { queryVariants, type WordVariants } from './variants.ts';

export const MIN_QUERY = 2;
// A pasted paragraph is not a query: each word is a dozen conditions on every title, name and message.
export const MAX_QUERY_LENGTH = 200;
export const MAX_QUERY_WORDS = 10;
const NO_FILES: SearchResponse['files'] = { files: [], unreadable: [], more: false };
const MAX_RESULTS = 50;

interface Row {
  id: string;
  title: string | null;
  agent_id: string;
  updated: Date;
  project_id: string | null;
}

interface PartsRow {
  id: string;
  // Text parts holding a word, in order, with who wrote them: an answer is shown as the chat draws it.
  messages: MessageText[];
  // The person's first message: the piece of text when the words are only in the title or in markup.
  opening: string | null;
}

// The text of a message as the search compares it — the expression of the index message_texts_search
// (core/db/migrations/0023_message_texts.sql).
const MESSAGE_TEXT = normalizedSql('mt.text');

// The person's conversations where every word is in the title or in the text of the messages — directly
// or with a typo. Messages holding a word are found through the index of their text (app.message_texts);
// those found directly come first, newest first in each part (spec, 8.13 and 8.21). Typos are looked for
// only when fewer than 50 are found directly: the others would not make the list.
async function searchThreads(client: pg.PoolClient, userId: string, words: WordVariants[]): Promise<{ rows: { row: Row; direct: boolean }[]; words: WordVariants[] }> {
  const direct = await threadsBy(client, userId, words, false);
  if (direct.length >= MAX_RESULTS) return { rows: direct, words };
  const corrected = await correctionsOf(client, words);
  return { rows: await threadsBy(client, userId, corrected, true), words: corrected };
}

async function threadsBy(client: pg.PoolClient, userId: string, words: WordVariants[], typos: boolean): Promise<{ row: Row; direct: boolean }[]> {
  const params = new SqlParams();
  const user = params.add(userId);
  const inMessages = (condition: string) => `SELECT mt.thread_id FROM app.message_texts mt WHERE mt.resource_id = ${user} AND ${condition}`;
  const pieces: string[] = [];
  const directs: string[] = [];
  const each: string[] = [];
  words.forEach((word, i) => {
    pieces.push(`d${i} AS (${inMessages(directCondition(MESSAGE_TEXT, word, params))})`);
    const direct = `(${directCondition('own.name', word, params)} OR own.id IN (SELECT thread_id FROM d${i}))`;
    directs.push(direct);
    const nameTypo = typos ? typoCondition('own.name', word, params) : null;
    const typoInText = typos ? typoPieces(word) : [];
    const typo = [nameTypo, typoInText.length > 0 ? `own.id IN (SELECT thread_id FROM t${i})` : null].filter((c): c is string => c !== null);
    if (typoInText.length > 0) pieces.push(`t${i} AS (${inMessages(piecesCondition(MESSAGE_TEXT, typoInText, params))})`);
    each.push(typo.length === 0 ? direct : `(${direct} OR ${typo.join(' OR ')})`);
  });
  const { rows } = await client.query<Row & { direct: boolean }>(
    `WITH own AS (
       SELECT t.id, t.title, ${normalizedSql('t.title')} AS name, t.metadata->>'agentId' AS agent_id, t."updatedAtZ" AS updated, tp.project_id
         FROM mastra.mastra_threads t
         LEFT JOIN app.thread_projects tp ON tp.thread_id = t.id AND tp.user_id = ${user}
        WHERE t."resourceId" = ${user} AND COALESCE(t.metadata->>'kind', 'chat') <> 'draft'
     ), ${pieces.join(', ')}
     SELECT own.id, own.title, own.agent_id, own.updated, own.project_id, (${directs.join(' AND ')}) AS direct
       FROM own
      WHERE ${each.join(' AND ')}
      ORDER BY direct DESC, own.updated DESC, own.id DESC
      LIMIT ${MAX_RESULTS}`,
    params.values,
  );
  return rows.map(({ direct, ...row }) => ({ row, direct }));
}

// For the piece of text of each found conversation: its messages holding a word, and its first words.
async function partsOf(client: pg.PoolClient, ids: string[], words: WordVariants[]): Promise<Map<string, PartsRow>> {
  if (ids.length === 0) return new Map();
  const params = new SqlParams();
  const list = params.add(ids);
  const holds = words.map((word) => {
    const typo = typoPieces(word);
    const direct = directCondition(MESSAGE_TEXT, word, params);
    return typo.length === 0 ? direct : `(${direct} OR ${piecesCondition(MESSAGE_TEXT, typo, params)})`;
  });
  const { rows } = await client.query<PartsRow>(
    `SELECT found.id,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('role', mt.role, 'text', mt.text) ORDER BY mt.created_at, mt.message_id)
                        FROM app.message_texts mt WHERE mt.thread_id = found.id AND (${holds.join(' OR ')})), '[]'::jsonb) AS messages,
            (SELECT mt.text FROM app.message_texts mt
              WHERE mt.thread_id = found.id AND mt.role = 'user' AND btrim(mt.text) <> ''
              ORDER BY mt.created_at, mt.message_id LIMIT 1) AS opening
       FROM unnest(${list}::text[]) AS found(id)`,
    params.values,
  );
  return new Map(rows.map((r) => [r.id, r]));
}

export async function search(deps: ProjectsDeps, userId: string, query: { q: string; scope: SearchScope }): Promise<SearchResponse> {
  if (query.q.trim().length < MIN_QUERY) {
    throw appError('APP_VALIDATION_FAILED', `search query "${query.q}" is too short`, { userMessage: `Введите хотя бы ${MIN_QUERY} символа.` });
  }
  if (query.q.length > MAX_QUERY_LENGTH || query.q.trim().split(/\s+/).length > MAX_QUERY_WORDS) {
    throw appError('APP_VALIDATION_FAILED', `search query of ${query.q.length} characters is too long`, {
      userMessage: `Запрос слишком длинный: оставьте до ${MAX_QUERY_WORDS} слов и ${MAX_QUERY_LENGTH} знаков.`,
    });
  }
  const words = await queryVariants(deps.db, query.q);
  // Only one-letter words («с», «и»): nothing to search by.
  if (words.length === 0) throw appError('APP_VALIDATION_FAILED', `search query "${query.q}" has no word of two letters`, { userMessage: `Введите хотя бы одно слово из ${MIN_QUERY} букв.` });
  const seen = (await listProjects(deps, userId)).projects;
  const { threads, parts, projectHits, corrected, files } = await inSearch(deps.db, async (client) => {
    const found = query.scope === 'all' || query.scope === 'threads' ? await searchThreads(client, userId, words) : { rows: [], words };
    return {
      threads: found.rows,
      parts: await partsOf(client, found.rows.map((f) => f.row.id), found.words),
      projectHits: query.scope === 'all' || query.scope === 'projects' ? await matchNames(client, seen.map((p) => p.name), words) : [],
      corrected: found.words,
      files: query.scope === 'all' || query.scope === 'files' ? await searchFiles(deps, client, userId, words, seen) : NO_FILES,
    };
  });
  // A conversation whose project the person no longer sees is shown without one (spec, 8.20).
  const seenIds = new Set(seen.map((p) => p.id));
  const projects = [...projectHits].sort((a, b) => Number(b.direct) - Number(a.direct)).map((hit) => seen[hit.index]!);
  return {
    threads: threads.map(({ row }) => {
      const piece = parts.get(row.id);
      return {
        id: row.id,
        agentId: row.agent_id,
        title: row.title ?? 'Без названия',
        snippet: snippetOf(piece?.messages ?? [], piece?.opening ?? null, row.title ?? '', corrected),
        projectId: row.project_id && seenIds.has(row.project_id) ? row.project_id : null,
        updatedAt: row.updated.toISOString(),
      };
    }),
    projects: projects.map((p) => ({ id: p.id, name: p.name, threadCount: p.threadCount, shared: p.shared, ownerName: p.role === 'member' ? p.owner.name : null })),
    files,
  };
}
