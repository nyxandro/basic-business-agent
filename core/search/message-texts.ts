// The text people saw in messages, for the search (spec, section 8.21): app.message_texts, kept by a
// trigger on Mastra's messages in the same transaction as the message — nothing lags or is copied
// later. Mastra makes its tables at its first start, after our migrations, so the server puts the
// trigger on at every start once they exist (a Mastra upgrade that makes the table anew gets it back),
// fills in messages saved while it was not there, removes rows of messages that are gone, and builds the
// dictionary of words (app.search_words) anew from the messages there are.
import { inTransaction, type Db } from '../db/pool.ts';

export const MESSAGE_TEXT_TRIGGER = 'bba_message_texts';
const REFRESH_STATISTICS_FROM = 1000;

export async function ensureMessageTexts(db: Db): Promise<void> {
  await db.query(
    `CREATE OR REPLACE TRIGGER ${MESSAGE_TEXT_TRIGGER} AFTER INSERT OR UPDATE OR DELETE ON mastra.mastra_messages
       FOR EACH ROW EXECUTE FUNCTION app.keep_message_text()`,
  );
  const filled = await db.query(
    `INSERT INTO app.message_texts (message_id, thread_id, resource_id, role, created_at, text)
     SELECT m.id, m.thread_id, m."resourceId", m.role, m."createdAtZ", app.message_visible_text(m.content)
       FROM mastra.mastra_messages m
      WHERE m.role IN ('user', 'assistant') AND NOT EXISTS (SELECT 1 FROM app.message_texts t WHERE t.message_id = m.id)
     ON CONFLICT (message_id) DO NOTHING`,
  );
  await db.query(`DELETE FROM app.message_texts t WHERE NOT EXISTS (SELECT 1 FROM mastra.mastra_messages m WHERE m.id = t.message_id)`);
  // The dictionary anew from the messages there are: words of removed messages (a name, a client) go.
  await inTransaction(db, async (client) => {
    await client.query('DELETE FROM app.search_words');
    await client.query('INSERT INTO app.search_words (word) SELECT DISTINCT w FROM app.message_texts mt, app.text_words(mt.text) AS w ORDER BY 1');
  });
  // The first start over an old database fills the table at once: the search plans need its statistics
  // before the background maintenance of the database gets to it.
  if ((filled.rowCount ?? 0) >= REFRESH_STATISTICS_FROM) await db.query('ANALYZE app.message_texts, app.search_words');
}
