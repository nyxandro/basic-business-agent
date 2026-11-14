// History of a conversation for the chat window (POST /app/api/copilotkit/agent/:id/connect):
// a snapshot of the messages from Mastra memory, the question still waiting for "Да"/"Нет" and the
// answers that broke and stayed broken (spec, section 9.1).
// CopilotKit's own runner replays only events it saw in this process, so after a restart — or for
// the conversation of a background task, which never ran through it — the chat would open empty.
import { randomUUID } from 'node:crypto';
import type { Memory } from '@mastra/memory';
import { CHAT_EVENTS, type DeclinedToolResult, type FailedTurns } from '@bba/contracts';
import { pendingForThread, supersededCallsOfThread } from '../approvals/requests.ts';
import type { Db } from '../db/pool.ts';
import { AppError } from '../errors/app-error.ts';
import { readHistory, type BrokenAnswer, type HistoryMessage } from './history.ts';
import type { TranslatedError } from './stream.ts';

const APPROVAL_PREFIX = 'mastra-approval::';
// Conversations of background tasks are "bg:<taskId>" (core/background/service.ts).
const BACKGROUND_THREAD_PREFIX = 'bg:';

type AguiMessage =
  | { id: string; role: 'user'; content: string }
  | { id: string; role: 'assistant'; content: string; toolCalls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { id: string; role: 'tool'; toolCallId: string; content: string };

// Mastra keeps a declined call as "output-denied" without a result.
const DENIED_STATE = 'output-denied';

export function toAguiMessages(history: HistoryMessage[], superseded: ReadonlySet<string>): AguiMessage[] {
  const out: AguiMessage[] = [];
  for (const m of history) {
    if (m.role === 'user') {
      out.push({ id: m.id, role: 'user', content: m.text });
      continue;
    }
    // A call still waiting for "Да" is shown by its card (the interrupt below), as in a live turn.
    const shown = m.toolCalls.filter((c) => c.state === 'result' || c.state === DENIED_STATE);
    const toolCalls = shown.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }));
    if (!m.text && toolCalls.length === 0) continue;
    out.push({ id: m.id, role: 'assistant', content: m.text, ...(toolCalls.length ? { toolCalls } : {}) });
    for (const c of shown) {
      if (c.state === DENIED_STATE) {
        const declined: DeclinedToolResult = { declined: true, superseded: superseded.has(c.id) };
        out.push({ id: `${c.id}:result`, role: 'tool', toolCallId: c.id, content: JSON.stringify(declined) });
        continue;
      }
      out.push({ id: `${c.id}:result`, role: 'tool', toolCallId: c.id, content: typeof c.result === 'string' ? c.result : JSON.stringify(c.result) });
    }
  }
  return out;
}

// A call waiting for "Да" reaches the chat only as an interrupt; when it is declined, Mastra's
// adapter sends nothing about it. These events show it in the chat as cancelled.
export function declinedCallEvents(call: { toolCallId: string; tool: string; args: unknown; superseded: boolean }): object[] {
  const declined: DeclinedToolResult = { declined: true, superseded: call.superseded };
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
async function failedTurns(broken: BrokenAnswer[], shown: ReadonlySet<string>, translate: (error: unknown) => Promise<TranslatedError>): Promise<FailedTurns | null> {
  if (broken.length === 0) return null;
  const last = broken.find((b) => b.last);
  return {
    interruptedMessageIds: broken.flatMap((b) => (b.messageId && shown.has(b.messageId) ? [b.messageId] : [])),
    last: last ? await translate(last.error) : null,
  };
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
  const messages = toAguiMessages(history, await supersededCallsOfThread(deps.db, input.userId, threadId));
  // Opening the conversation shows the result of a background task: it is no longer «новое».
  if (thread.metadata?.unread === true) await deps.memory.updateThread({ id: thread.id, title: thread.title ?? '', metadata: { ...thread.metadata, unread: false } });
  // The menu counter of fresh task results reads the flags of the employee's runs of the task.
  if (threadId.startsWith(BACKGROUND_THREAD_PREFIX)) {
    const taskId = threadId.slice(BACKGROUND_THREAD_PREFIX.length).split(':')[0];
    await deps.db.query('UPDATE app.background_task_runs SET unread = false WHERE task_id = $1 AND user_id = $2 AND unread', [taskId, input.userId]);
  }
  const pending = await pendingForThread(deps.db, input.userId, threadId);
  const interrupts = pending.map((p) => ({
    id: `${APPROVAL_PREFIX}${p.runId}::${p.toolCallId}`,
    reason: 'mastra:tool_approval',
    toolCallId: p.toolCallId,
    expiresAt: p.expiresAt.toISOString(),
    metadata: { mastra: { type: 'mastra_tool_approval', toolName: p.tool, args: waitingArgs.get(p.toolCallId) ?? p.args, runId: p.runId } },
  }));
  const failed = await failedTurns(broken, new Set(messages.map((m) => m.id)), deps.translate);
  return sse([
    { type: 'RUN_STARTED', threadId, runId },
    { type: 'MESSAGES_SNAPSHOT', messages },
    ...(failed ? [{ type: 'CUSTOM', name: CHAT_EVENTS.turnsFailed, value: failed }] : []),
    { type: 'RUN_FINISHED', threadId, runId, ...(interrupts.length ? { outcome: { type: 'interrupt', interrupts } } : {}) },
  ]);
}
