// The index of the text people saw in messages (spec, section 8.21): pieces of words and typos are
// found through it instead of reading every message. It lives on Mastra's table, which Mastra makes
// at its first start — after our migrations — so the server makes the index once Mastra's tables
// exist, at every start: should a Mastra upgrade make the table anew, the index comes back with the
// next start. Only the messages of the person and the agent are indexed: the search reads no others.
import type { Db } from '../db/pool.ts';

export const MESSAGE_TEXT_INDEX = 'bba_messages_search_text';

export async function ensureMessageTextIndex(db: Db): Promise<void> {
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${MESSAGE_TEXT_INDEX} ON mastra.mastra_messages
       USING gin (app.message_search_text(content) gin_trgm_ops) WHERE role IN ('user', 'assistant')`,
  );
}
