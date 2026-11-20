// A widget in the chat (spec, section 8.31): a call of `render_ui` drawn by CopilotKit's engine. The operations of the
// call — and the changes later calls of the same answer made to its screen — go to the engine's manager of surfaces
// with a place of their own (a target per call), and `GenerativeUISurface` draws it: live while the agent writes the
// call, and again from the stored calls after a reload. A call that only changed a screen draws nothing of its own.
// A call the server's check refused draws nothing: no line «rebuilding» — the agent may not rebuild (owner, 20.11).
import { WIDGET_CATALOG_ID } from '@bba/contracts';
import { useAgent } from '@copilotkit/react-core';
import { GenerativeUISurface, useGenerativeUIRuntime } from '@copilotkit/react-core/generative-ui';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useUnfinished } from '../chat/call-progress.ts';
import { parseToolResult } from '../chat/tool-result.ts';
import { Preparing, type CallProps } from '../genui/CatalogBlock.tsx';
import { ru } from '../i18n/ru.ts';
import { answerOf } from '../genui/answer.ts';
import { BusyPress } from './busy.tsx';
import { changesAScreen, drawableOperations, laterChanges } from './operations.ts';
import { screensOfAnswer, WidgetReplyContext, widgetReply } from './reply.ts';
import styles from './widgets.module.css';

export function WidgetCall({ call }: { call: CallProps }) {
  const runtime = useGenerativeUIRuntime();
  const { agent } = useAgent();
  const unfinished = useUnfinished()({ name: '' });
  const outcome = call.status === 'complete' ? parseToolResult(call.result).kind : null;
  const refused = outcome === 'failed';
  const target = `w-${call.toolCallId}`;
  const own = useMemo(() => drawableOperations(call.parameters, call.toolCallId, call.status === 'complete'), [call.parameters, call.toolCallId, call.status]);
  const messages = agent.messages;
  const operations = useMemo(() => {
    if (!own.written || !own.surfaceId || call.status !== 'complete') return own;
    return { ...own, ops: [...own.ops, ...laterChanges(messages, call.toolCallId, own.written, own.surfaceId)] };
  }, [own, messages, call.toolCallId, call.status]);
  const threadId = agent.threadId;
  // The person's answer to the widget: what it marks and makes inactive (reply.ts).
  const reply = answerOf(messages, call.toolCallId);
  const replied = useMemo(() => widgetReply(operations.ops, screensOfAnswer(messages, call.toolCallId), reply), [operations.ops, messages, call.toolCallId, reply]);
  // A press CopilotKit did not send while the agent was answering (busy.tsx): a line says to press again, until the
  // answer is done (state adjusted while rendering, as React advises for a change of a value).
  const [pressedBusy, setPressedBusy] = useState(false);
  const running = agent.isRunning;
  const [wasRunning, setWasRunning] = useState(running);
  if (wasRunning !== running) {
    setWasRunning(running);
    if (!running) setPressedBusy(false);
  }
  const reportBusy = useMemo(() => () => setPressedBusy(true), []);

  useEffect(() => {
    if (!runtime || !threadId || refused || operations.ops.length === 0 || !operations.surfaceId) return;
    runtime.manager.setActiveThread(threadId);
    // The engine checks each operation itself (the server checked them before): the type of A2UI is its business.
    runtime.manager.ingest(threadId, agent.agentId, {
      surfaceId: operations.surfaceId,
      target,
      catalogId: WIDGET_CATALOG_ID,
      operations: operations.ops as Parameters<typeof runtime.manager.ingest>[2]['operations'],
      status: call.status === 'complete' ? 'ready' : 'streaming',
      rejected: [],
    });
  }, [runtime, threadId, agent.agentId, refused, operations, target, call.status]);

  if (refused) return null;
  // The answer ended without the result: «Стоп» or a broken answer — what was drawn is not a screen to work with.
  if (call.status !== 'complete' && unfinished === 'stopped') return <p className={styles.note}>{ru.widgets.stopped}</p>;
  // A change of a screen drawn above it: the screen shows it, also while the change is written.
  if (!runtime || (!own.written && (call.status === 'complete' || changesAScreen(call.parameters)))) return null;
  return (
    <div className={styles.widget} style={{ '--broken-part': JSON.stringify(ru.widgets.brokenPart) } as CSSProperties}>
      <BusyPress.Provider value={reportBusy}>
        <WidgetReplyContext.Provider value={replied}>
          <GenerativeUISurface id={target} fallback={<Preparing />} autoScroll={false} />
        </WidgetReplyContext.Provider>
      </BusyPress.Provider>
      {pressedBusy && running && (
        <p className={styles.note} role="status">
          {ru.widgets.busy}
        </p>
      )}
    </div>
  );
}
