// The name of a conversation (spec, section 8.16): where it came from and who may still change it.
// The name is written into Mastra's thread row by one statement of our own: the model's name must
// never overwrite a name the person gave while the model was thinking, and a rename must not move
// the conversation in «Недавние» (Mastra's own update stamps `updatedAt`).
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';

// `first-message` — the name is the first message, the model may still name the conversation;
// `auto` — the model named it; `manual` — the person did. Conversations from before the names
// (15.11) have no source and keep their names.
export type TitleSource = 'first-message' | 'auto' | 'manual';
export const FIRST_MESSAGE: TitleSource = 'first-message';

export function awaitsName(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.titleSource === FIRST_MESSAGE;
}

// False when the person named the conversation meanwhile or it is gone: nothing is written then.
export async function setAutoTitle(db: Db, threadId: string, title: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE mastra.mastra_threads SET title = $2, metadata = metadata || jsonb_build_object('titleSource', 'auto')
      WHERE id = $1 AND metadata->>'titleSource' = 'first-message'`,
    [threadId, title],
  );
  return rowCount === 1;
}

export async function renameThread(db: Db, userId: string, threadId: string, title: string): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE mastra.mastra_threads SET title = $3, metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('titleSource', 'manual')
      WHERE id = $1 AND "resourceId" = $2`,
    [threadId, userId, title],
  );
  if (rowCount !== 1) throw appError('APP_NOT_FOUND', `thread ${threadId} not found for user`, { userMessage: 'Разговор не найден.' });
}
