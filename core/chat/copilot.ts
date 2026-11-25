// CopilotKit runtime under /app/api/copilotkit (spec, section 17.5), built per request:
// the AG-UI agent gets the employee from the session (resource id and request context are set
// by the server, never by the browser) and the published — or, for a draft check, the draft —
// version of the agent from Mastra Editor.
import { MastraAgent } from '@ag-ui/mastra';
import { CopilotRuntime, createCopilotRuntimeHandler, InMemoryAgentRunner } from '@copilotkit/runtime';
import type { AbstractAgent } from '@ag-ui/client';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { CHAT_EVENTS } from '@bba/contracts';
import { filter, finalize, Observable, Subject, tap } from 'rxjs';
import type { ContextFillTell } from '../context-fill/processor.ts';
import type { WebProgress } from '../web/trail.ts';
import { resolveAgent, type EditorDeps } from '../editor/prompts.ts';
import { REQUEST_KEYS } from '../run-context/request-keys.ts';
import { requestContextFor, type PreparedRun } from './run.ts';
import { newRunLife } from './after-leaving.ts';

export const COPILOT_BASE_PATH = '/app/api/copilotkit';

export type CopilotRequestContext =
  // `onMessageDiscarded` learns the messages whose words a repeated model call dropped (spec, 9.1).
  // `onAgentEnd` is told when the agent itself ends — finished, stopped or failed — which may be well
  // after the browser went away: CopilotKit lets the run go on without it.
  | { kind: 'run'; run: PreparedRun; onMessageDiscarded: (messageId: string) => void; onAgentEnd: () => void }
  // /info and connect: the agents open to the employee, without a conversation-bound context.
  | { kind: 'listing'; userId: string; agentIds: string[]; mode: 'published' | 'draft' };

export interface CopilotHandler {
  handle(request: Request, ctx: CopilotRequestContext): Promise<Response>;
}

// What CopilotKit keeps in the memory of the process (@copilotkit/runtime rc.49, InMemoryAgentRunner): the answers under
// way — never dropped, whatever the limits — and the events of finished turns, only for its own reconnection, which this
// server does not use (a conversation is opened from the database, core/chat/connect.ts). Its defaults let it grow to
// 1 000 conversations and 512 MB; these bound the worst case — long conversations with big results of tools — to a
// little (issue #35; in the load test of 24.11 the history itself stayed far below either bound).
const RUNNER_LIMITS = { maxThreads: 200, maxRunsPerThread: 10, maxBytes: 64 * 1024 * 1024 };

// CopilotKit's runtime sends usage events to its servers on every request unless this switch is
// set; it reads the switch at each event. Employees' activity of a closed installation stays
// inside, so the switch is set in code before the runtime exists, not left to deployment settings.
function disableCopilotTelemetry(): void {
  // eslint-disable-next-line no-restricted-properties -- not a setting read from the deployment: a switch the library reads itself, set here on purpose
  process.env.COPILOTKIT_TELEMETRY_DISABLED = 'true';
}

export function createCopilotHandler(deps: { editor: EditorDeps }): CopilotHandler {
  disableCopilotTelemetry();
  const contexts = new WeakMap<Request, CopilotRequestContext>();

  // A listing never calls a model, so only a run is told about dropped messages.
  async function agentFor(agentId: string, run: PreparedRun, live?: { onMessageDiscarded: (messageId: string) => void; onAgentEnd: () => void }): Promise<AbstractAgent> {
    const agent = await resolveAgent(deps.editor, agentId, run.mode);
    const requestContext = requestContextFor(run);
    // Every call of a server tool goes to the chat the moment the agent makes it, not with its result (decision of
    // the owner 20.11: like Codex and Claude Code): by default the adapter holds a server call back until its result,
    // so a long tool (the search of the internet, a document) showed nothing while it ran. A call that waits for «Да»
    // is then shown too and closed without a result of its own: the question carries it (web/src/chat/ToolRow.tsx).
    const mastraAgent = new MastraAgent({ agent, agentId, resourceId: run.resourceId, requestContext, streamServerToolCalls: true });
    if (!live) return mastraAgent;
    requestContext.set(REQUEST_KEYS.messageDiscarded, live.onMessageDiscarded);
    // The steps of the researcher of the internet go to the browser at once, between the agent's own events
    // (spec, section 8.30: the live block of the search) — the agent's stream is silent while a tool works.
    const progress = new Subject<BaseEvent>();
    const tell: WebProgress = (toolCallId, step) => progress.next({ type: EventType.CUSTOM, name: CHAT_EVENTS.webProgress, value: { toolCallId, step } });
    requestContext.set(REQUEST_KEYS.webProgress, tell);
    // How full the conversation is, after every call of the model (spec, section 8.34): the same way, between the
    // agent's events — the call ends before its tools run and before the next call.
    const fill: ContextFillTell = (threadId, context) => progress.next({ type: EventType.CUSTOM, name: CHAT_EVENTS.contextFill, value: { threadId, context } });
    requestContext.set(REQUEST_KEYS.contextFill, fill);
    // A middleware survives the copy of the agent CopilotKit makes for a run; `finalize` fires once
    // the agent's events end — completed, failed or unsubscribed by «Стоп».
    // The «state of the agent» is cut both ways (spec, 8.26): the chat does not use it, and the adapter of
    // Mastra carried the personal memory through it — read past our settings after every run, sent to the
    // browser, and written back from the browser's next run.
    return mastraAgent.use((input, next) => {
      run.agentStarted = true;
      const events = next
        .run({ ...input, state: {} })
        .pipe(
          filter((event) => event.type !== EventType.STATE_SNAPSHOT && event.type !== EventType.STATE_DELTA),
          // A broken answer is told as «Ответ не получился» if the person left before it ended.
          tap({ next: (event) => void (event.type === EventType.RUN_ERROR && (run.life.failed = true)), error: () => void (run.life.failed = true) }),
          finalize(live.onAgentEnd),
        );
      // The steps only while the agent's events go: they end, fail or are stopped together.
      return new Observable<BaseEvent>((subscriber) => {
        const steps = progress.subscribe((event) => subscriber.next(event));
        const agentEvents = events.subscribe(subscriber);
        return () => {
          steps.unsubscribe();
          agentEvents.unsubscribe();
        };
      });
    });
  }

  const runtime = new CopilotRuntime({
    runner: new InMemoryAgentRunner(RUNNER_LIMITS),
    agents: async ({ request }) => {
      const ctx = contexts.get(request);
      if (!ctx) throw new Error('CopilotKit request reached the runtime without a server context');
      if (ctx.kind === 'run') return { [ctx.run.agentId]: await agentFor(ctx.run.agentId, ctx.run, { onMessageDiscarded: ctx.onMessageDiscarded, onAgentEnd: ctx.onAgentEnd }) };
      const entries = await Promise.all(
        ctx.agentIds.map(async (id) => [id, await agentFor(id, { agentId: id, userId: ctx.userId, resourceId: ctx.userId, threadId: `listing-${ctx.userId}`, mode: ctx.mode, projectId: null, projectOwnerId: null, lostProject: null, snapshot: null, agentStarted: false, models: null, skillPaths: [], abilities: null, release: null, life: newRunLife() })] as const),
      );
      return Object.fromEntries(entries);
    },
  });
  const handler = createCopilotRuntimeHandler({ runtime, basePath: COPILOT_BASE_PATH, cors: false, activateChannels: false });

  return {
    handle(request, ctx) {
      contexts.set(request, ctx);
      return handler(request);
    },
  };
}
