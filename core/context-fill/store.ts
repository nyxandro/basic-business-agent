// How full a conversation is (spec, section 8.34): one row per conversation — the last call of the model of its
// agent — and the size of the context of that model, read when the chat asks.
import type { ThreadContextFill } from '@bba/contracts';
import type { Db } from '../db/pool.ts';
import { storedMessageCount } from '../history/store.ts';
import { LAST_MESSAGES } from '../memory/memory.ts';

export async function recordFill(db: Db, call: { threadId: string; userId: string; modelId: string; tokens: number }): Promise<void> {
  await db.query(
    `INSERT INTO app.thread_context (thread_id, user_id, model_id, tokens) VALUES ($1, $2, $3, $4)
     ON CONFLICT (thread_id) DO UPDATE SET model_id = EXCLUDED.model_id, tokens = EXCLUDED.tokens, updated_at = now()`,
    [call.threadId, call.userId, call.modelId, call.tokens],
  );
}

// Only the person's own conversation: the row is looked for by the conversation and the person, so a conversation of
// someone else and one without an answer yet are the same — nothing. A model without a size of the context (the
// gateway does not know it, the admin gave none, or it was removed) shows nothing either (decision of the owner 25.11).
export async function fillOf(db: Db, userId: string, threadId: string): Promise<ThreadContextFill | null> {
  const { rows } = await db.query<{ tokens: number; limit: number | null }>(
    `SELECT c.tokens, m.max_input_tokens AS limit
       FROM app.thread_context c LEFT JOIN app.models m ON m.id = c.model_id
      WHERE c.thread_id = $1 AND c.user_id = $2`,
    [threadId, userId],
  );
  const row = rows[0];
  if (!row || row.limit === null) return null;
  return { tokens: row.tokens, limit: row.limit, hidden: (await storedMessageCount(db, threadId)) > LAST_MESSAGES };
}
