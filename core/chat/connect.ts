// History of a conversation for the chat window (POST /app/api/copilotkit/agent/:id/connect):
// a snapshot of the messages from Mastra memory, the question still waiting for "Да"/"Нет" and the
// answers that broke and stayed broken (spec, section 9.1).
// CopilotKit's own runner replays only events it saw in this process, so after a restart — or for
// the conversation of a background task, which never ran through it — the chat would open empty.
import { randomUUID } from 'node:crypto';
import type { Memory } from '@mastra/memory';
import { CHAT_EVENTS, type DeclinedToolResult, type FailedTurns } from '@bba/contracts';
import { expiredCallsOfThread, pendingForThread, supersededCallsOfThread } from '../approvals/requests.ts';
import { markThreadRead } from '../notifications/list.ts';
import type { Db } from '../db/pool.ts';
import { AppError } from '../errors/app-error.ts';
import { ERROR_CATALOG } from '../errors/catalog.ts';
import { logEvent } from '../server/log.ts';
import { readHistory, type BrokenAnswer, type HistoryMessage, type StoredMessage } from './history.ts';
import { lastBrokenTurn, verdictOf } from './retry.ts';
import type { TranslatedError } from './stream.ts';

const APPROVAL_PREFIX = 'mastra-approval::';

type AguiMessage =
  | { id: string; role: 'user'; content: string }
  | { id: string; role: 'assistant'; content: string; toolCalls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { id: string; role: 'tool'; toolCallId: string; content: string };

// Mastra keeps a declined call as "output-denied" without a result.
const DENIED_STATE = 'output-denied';

// `expired` — calls whose question burnt unanswered, with its term: shown as «Вопрос истёк», even before the waiting
// answer got its refusal (that comes with the next message, core/chat/run.ts).
export function toAguiMessages(history: HistoryMessage[], superseded: ReadonlySet<string>, expired: ReadonlyMap<string, number> = new Map()): AguiMessage[] {
  const out: AguiMessage[] = [];
  for (const m of history) {
    if (m.role === 'user') {
      out.push({ id: m.id, role: 'user', content: m.text });
      continue;
    }
    // A call still waiting for "Да" is shown by its card (the interrupt below), a call left without a result not at all.
    // A live turn shows such calls as lines too — «Ждёт вашего подтверждения», «Прервано» (web/src/chat/call-progress.ts).
    const shown = m.toolCalls.filter((c) => c.state === 'result' || c.state === DENIED_STATE || expired.has(c.id));
    const toolCalls = shown.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }));
    if (!m.text && toolCalls.length === 0) continue;
    out.push({ id: m.id, role: 'assistant', content: m.text, ...(toolCalls.length ? { toolCalls } : {}) });
    for (const c of shown) {
      if (c.state === DENIED_STATE || (c.state !== 'result' && expired.has(c.id))) {
        const declined: DeclinedToolResult = { declined: true, superseded: superseded.has(c.id), expiredHours: expired.get(c.id) ?? null };
        out.push({ id: `${c.id}:result`, role: 'tool', toolCallId: c.id, content: JSON.stringify(declined) });
        continue;
      }
      out.push({ id: `${c.id}:result`, role: 'tool', toolCallId: c.id, content: typeof c.result === 'string' ? c.result : JSON.stringify(c.result) });
    }
  }
  return out;
}

// When a call waiting for "Да" is declined, Mastra's adapter sends nothing about it. These events show it in the chat
// as cancelled: a chat opened since has no such call and gets it; a live one has it already (core/chat/copilot.ts streams
// every call) and the AG-UI client updates it.
export function declinedCallEvents(call: { toolCallId: string; tool: string; args: unknown; superseded: boolean; expiredHours: number | null }): object[] {
  const declined: DeclinedToolResult = { declined: true, superseded: call.superseded, expiredHours: call.expiredHours };
  return [
    { type: 'TOOL_CALL_START', toolCallId: call.toolCallId, toolCallName: call.tool, parentMessageId: `${call.toolCallId}:call` },
    { type: 'TOOL_CALL_ARGS', toolCallId: call.toolCallId, delta: JSON.stringify(call.args ?? {}) },
    { type: 'TOOL_CALL_END', toolCallId: call.toolCallId },
    { type: 'TOOL_CALL_RESULT', messageId: `${call.toolCallId}:result`, toolCallId: call.toolCallId, role: 'tool', content: JSON.stringify(declined) },
  ];
}

function sse(events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}

// Broken answers as the chat shows them: marked where they are on the screen, the last one with what
// happened in our code and words (the kept failure is technical and never goes to the browser).
// Explaining a kept failure may need the gateway (whose limit ran out); a conversation opens even
// when the gateway is down, and then that is what the person reads.
async function explain(translate: (error: unknown) => Promise<TranslatedError>, failure: unknown): Promise<TranslatedError> {
  try {
    return await translate(failure);
  } catch (error) {
    logEvent('warn', 'chat_failure_explain_failed', { error: error instanceof Error ? error.name : 'unknown' });
    return { code: 'APP_MODEL_GATEWAY_UNAVAILABLE', message: ERROR_CATALOG.APP_MODEL_GATEWAY_UNAVAILABLE.userMessage };
  }
}

async function failedTurns(
  deps: { db: Db; translate: (error: unknown) => Promise<TranslatedError> },
  input: { userId: string; threadId: string; stored: StoredMessage[]; broken: BrokenAnswer[]; shown: ReadonlySet<string> },
): Promise<FailedTurns | null> {
  if (input.broken.length === 0) return null;
  const turn = lastBrokenTurn(input.stored);
  let last: FailedTurns['last'] = null;
  if (turn) {
    const explained = await explain(deps.translate, turn.error);
    last = { ...explained, ...(await verdictOf(deps.db, { userId: input.userId, threadId: input.threadId, turn, code: explained.code })) };
  }
  return { interruptedMessageIds: input.broken.flatMap((b) => (b.messageId && input.shown.has(b.messageId) ? [b.messageId] : [])), last };
}

export async function connectResponse(
  deps: { db: Db; memory: Memory; translate: (error: unknown) => Promise<TranslatedError> },
  input: { userId: string; resourceId: string; agentId: string; threadId: string },
): Promise<Response> {
  const runId = randomUUID();
  const { threadId } = input;
  const thread = await deps.memory.getThreadById({ threadId });
  if (thread && (thread.resourceId !== input.resourceId || thread.metadata?.agentId !== input.agentId)) {
    throw new AppError({ code: 'APP_NOT_FOUND', message: 'connect to a foreign or other-agent thread', userMessage: 'Разговор не найден.', status: 404 });
  }
  // A conversation that does not exist yet has no history. Nothing is sent: an empty snapshot that
  // arrives after the person's first message would wipe it from the screen.
  if (!thread) return sse([]);
  const recalled = await deps.memory.recall({ threadId, resourceId: thread.resourceId, perPage: false });
  const { history, broken } = readHistory(recalled.messages);
  // Arguments of calls waiting for "Да", as the model sent them (the database keeps a summary).
  const waitingArgs = new Map(history.flatMap((m) => m.toolCalls.map((c) => [c.id, c.args] as const)));
  const messages = toAguiMessages(history, await supersededCallsOfThread(deps.db, input.userId, threadId), await expiredCallsOfThread(deps.db, input.userId, threadId));
  // Opening the conversation shows the result of a background task: it is no longer «новое».
  // Only the mark: Mastra merges it under a row lock and keeps the name (spec, 8.16).
  if (thread.metadata?.unread === true) await deps.memory.updateThread({ id: thread.id, metadata: { unread: false } });
  // …and what its notifications told («Готово», «Ответ готов») is read.
  await markThreadRead(deps.db, input.userId, threadId);
  const pending = await pendingForThread(deps.db, input.userId, threadId);
  const interrupts = pending.map((p) => ({
    id: `${APPROVAL_PREFIX}${p.runId}::${p.toolCallId}`,
    reason: 'mastra:tool_approval',
    toolCallId: p.toolCallId,
    expiresAt: p.expiresAt.toISOString(),
    metadata: { mastra: { type: 'mastra_tool_approval', toolName: p.tool, args: waitingArgs.get(p.toolCallId) ?? p.args, runId: p.runId } },
  }));
  const failed = await failedTurns(deps, { userId: input.userId, threadId, stored: recalled.messages, broken, shown: new Set(messages.map((m) => m.id)) });
  return sse([
    { type: 'RUN_STARTED', threadId, runId },
    { type: 'MESSAGES_SNAPSHOT', messages },
    ...(failed ? [{ type: 'CUSTOM', name: CHAT_EVENTS.turnsFailed, value: failed }] : []),
    { type: 'RUN_FINISHED', threadId, runId, ...(interrupts.length ? { outcome: { type: 'interrupt', interrupts } } : {}) },
  ]);
}
