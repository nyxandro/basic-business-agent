// The person left before the answer ended (docs/specs/[20.11.2026]-notifications.md, scenario 4): CopilotKit lets the
// agent finish without the browser, and the person learns how it ended — «Ждёт вашего решения» when the answer stopped
// at a question «Да», «Ответ не получился» when it broke, «Ответ готов» otherwise. Whether a push goes or the page
// shows it (another tab of the person is open) is decided at delivery.
import { randomUUID } from 'node:crypto';
import { notifyQuestion, pendingForThread } from '../approvals/requests.ts';
import type { Db } from '../db/pool.ts';
import { notices } from '../notifications/kinds.ts';
import { notify } from '../notifications/notify.ts';
import { logEvent } from '../server/log.ts';

// What became of one turn of the chat, filled while it goes.
export interface RunLife {
  // Names this turn in its notification («Ответ готов» once per turn).
  key: string;
  ended: boolean;
  // The browser's stream closed while the agent still worked.
  browserLeft: boolean;
  // «Стоп» of the person: CopilotKit closes the stream first and asks to stop after — the person is there, nothing to tell.
  stopped: boolean;
  failed: boolean;
}

export const newRunLife = (): RunLife => ({ key: randomUUID(), ended: false, browserLeft: false, stopped: false, failed: false });

export async function tellAfterLeaving(db: Db, run: { userId: string; agentId: string; threadId: string; life: RunLife }): Promise<void> {
  try {
    const waiting = await pendingForThread(db, run.userId, run.threadId);
    if (waiting.length > 0) {
      for (const q of waiting) await notifyQuestion(db, q);
      return;
    }
    const { rows } = await db.query<{ title: string | null }>('SELECT title FROM mastra.mastra_threads WHERE id = $1', [run.threadId]);
    const told = { userId: run.userId, runKey: run.life.key, agentId: run.agentId, threadId: run.threadId, threadTitle: rows[0]?.title || 'Без названия' };
    await notify(db, run.life.failed ? notices.answerFailed(told) : notices.answerReady(told));
  } catch (error) {
    // notify never throws; a failed read of the question or the name is logged, the turn is over anyway.
    logEvent('error', 'notification_failed', { code: 'APP_NOTIFICATION_FAILED', threadId: run.threadId, error });
  }
}
