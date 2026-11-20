// A widget in the chat (spec, section 8.31): a call of `render_ui` drawn by CopilotKit's engine. The operations of the
// call — and the changes later calls of the same answer made to its screen — go to the engine's manager of surfaces
// with a place of their own (a target per call), and `GenerativeUISurface` draws it: live while the agent writes the
// call, and again from the stored calls after a reload. A call that only changed a screen draws nothing of its own.
// A call the server's check refused draws nothing: while the agent rebuilds the screen, a line says so.
import { WIDGET_CATALOG_ID } from '@bba/contracts';
import { useAgent } from '@copilotkit/react-core';
import { GenerativeUISurface, useGenerativeUIRuntime } from '@copilotkit/react-core/generative-ui';
import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { TurnStateContext, useUnfinished } from '../chat/call-progress.ts';
import { parseToolResult } from '../chat/tool-result.ts';
import { Preparing, type CallProps } from '../genui/CatalogBlock.tsx';
import { ru } from '../i18n/ru.ts';
import { BusyPress } from './busy.tsx';
import { drawableOperations, laterChanges } from './operations.ts';
import styles from './widgets.module.css';

export function WidgetCall({ call }: { call: CallProps }) {
  const runtime = useGenerativeUIRuntime();
  const { agent } = useAgent();
  const turn = useContext(TurnStateContext);
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
  // A press CopilotKit dropped while the agent was answering (busy.tsx) is made again once the answer is done; the
  // latest one wins. Meanwhile a line says so.
  const again = useRef<(() => void) | null>(null);
  const [waiting, setWaiting] = useState(false);
  const running = agent.isRunning;
  // The end of the answer clears the line (state adjusted while rendering, as React advises for a change of a value).
  const [wasRunning, setWasRunning] = useState(running);
  if (wasRunning !== running) {
    setWasRunning(running);
    if (!running) setWaiting(false);
  }
  useEffect(() => {
    if (running) return;
    const press = again.current;
    again.current = null;
    press?.();
  }, [running]);
  const reportBusy = useMemo(
    () => (press: () => void) => {
      again.current = press;
      setWaiting(true);
    },
    [],
  );

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

  if (refused) return turn === 'answering' ? <p className={styles.note}>{ru.widgets.rebuilding}</p> : null;
  // The answer ended without the result: «Стоп» or a broken answer — what was drawn is not a screen to work with.
  if (call.status !== 'complete' && unfinished === 'stopped') return <p className={styles.note}>{ru.widgets.stopped}</p>;
  // A change of a screen drawn above it: the screen shows it.
  if (!runtime || (call.status === 'complete' && !own.written)) return null;
  return (
    <div className={styles.widget} style={{ '--broken-part': JSON.stringify(ru.widgets.brokenPart) } as CSSProperties}>
      <BusyPress.Provider value={reportBusy}>
        <GenerativeUISurface id={target} fallback={<Preparing />} autoScroll={false} />
      </BusyPress.Provider>
      {waiting && running && (
        <p className={styles.note} role="status">
          {ru.widgets.busy}
        </p>
      )}
    </div>
  );
}
