// «Ответить заново» (spec, section 9.1): only the last answer of a conversation that broke and
// stayed broken is answered again, only when a repeat can help and no action ran after «Да» in that
// turn (decision of the owner 15.11). The question and everything after it leave the conversation,
// and the chat sends the question once more as it was — attachments included — as a new turn.
import { ANSWER_AGAIN_CODES } from '@bba/contracts';
import type { Memory } from '@mastra/memory';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { readHistory, textOfStored, type StoredMessage } from './history.ts';

export interface BrokenTurn {
  question: StoredMessage;
  // The failure Mastra kept in the answer: technical, for our code and words only.
  error: unknown;
  // The question and everything after it.
  ids: string[];
}

// The last turn of the conversation, when its answer broke and stayed broken.
export function lastBrokenTurn(stored: StoredMessage[]): BrokenTurn | null {
  const last = readHistory(stored).broken.find((b) => b.last);
  const at = stored.findLastIndex((m) => m.role === 'user');
  const question = stored[at];
  if (!last || !question) return null;
  return { question, error: last.error, ids: stored.slice(at).map((m) => m.id) };
}

// An action the person said «Да» to ran in this turn: asking the question again would ask for it
// again, and the record of it would leave the conversation.
async function actionRanIn(db: Db, userId: string, threadId: string, turn: BrokenTurn): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM app.approval_requests WHERE user_id = $1 AND thread_id = $2 AND status = $3 AND created_at >= $4 LIMIT 1', [
    userId,
    threadId,
    'approved',
    new Date(turn.question.createdAt),
  ]);
  return rows.length > 0;
}

export interface BrokenTurnVerdict {
  answerAgain: boolean;
  actionDone: boolean;
}

export async function verdictOf(db: Db, input: { userId: string; threadId: string; turn: BrokenTurn; code: string }): Promise<BrokenTurnVerdict> {
  const actionDone = await actionRanIn(db, input.userId, input.threadId, input.turn);
  return { actionDone, answerAgain: ANSWER_AGAIN_CODES.includes(input.code) && !actionDone };
}

// The broken turn the person asks to answer again — the one they see — or why it cannot be.
export async function turnToAnswerAgain(
  deps: { db: Db; memory: Memory; codeOf: (failure: unknown) => Promise<string> },
  input: { userId: string; threadId: string; resourceId: string; questionId: string },
): Promise<BrokenTurn> {
  const { messages } = await deps.memory.recall({ threadId: input.threadId, resourceId: input.resourceId, perPage: false });
  const turn = lastBrokenTurn(messages);
  if (!turn || turn.question.id !== input.questionId) {
    throw appError('APP_CHAT_NOT_INTERRUPTED', `thread ${input.threadId}: the last answer is not a broken answer to ${input.questionId}`);
  }
  const code = await deps.codeOf(turn.error);
  const verdict = await verdictOf(deps.db, { userId: input.userId, threadId: input.threadId, turn, code });
  if (verdict.actionDone) throw appError('APP_CHAT_ACTION_DONE', `thread ${input.threadId}: an approved action ran in the broken turn`);
  if (!verdict.answerAgain) throw appError('APP_CHAT_ANSWER_AGAIN_USELESS', `thread ${input.threadId}: the answer broke with ${code}, a repeat would not help`);
  return turn;
}

export async function takeBack(memory: Memory, turn: BrokenTurn): Promise<string> {
  await memory.deleteMessages(turn.ids);
  return textOfStored(turn.question);
}
