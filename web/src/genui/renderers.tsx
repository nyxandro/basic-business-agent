// Draws widgets (spec, section 8.31), the blocks of earlier conversations and every other tool call inside CopilotChat
// (spec, section 17.8). The five former blocks are not the agent's any more (F40), but old conversations hold them.
import { cardBlockSchema, chartBlockSchema, choiceBlockSchema, formBlockSchema, GENUI_TOOL, modelTableBlockSchema, WEB_RESEARCH_TOOL, WIDGET_TOOL, type AgentSummary } from '@bba/contracts';
import { useAgent, useCopilotKit, useRenderTool } from '@copilotkit/react-core';
import { lazy, Suspense, useCallback } from 'react';
import { z } from 'zod';
import { ToolRow } from '../chat/ToolRow.tsx';
import { BrokenData } from './BrokenData.tsx';
import { CardBlockView } from './CardBlock.tsx';
import { CatalogBlock, Preparing, type CallProps } from './CatalogBlock.tsx';
import { answerOf } from './answer.ts';
import { ChoiceBlockView } from './ChoiceBlock.tsx';
import { FileCall } from './FileBlock.tsx';
import { useChatExtras } from '../chat/chat-context.ts';
import { FormBlockView } from './FormBlock.tsx';
import { TableBlockView } from './TableBlock.tsx';
import { WebSearch } from '../chat/WebSearch.tsx';
import { WidgetCall } from '../widgets/WidgetCall.tsx';

// A chart is drawn by code most conversations never need: it is loaded with the first chart.
const ChartBlockView = lazy(() => import('./ChartBlock.tsx').then((m) => ({ default: m.ChartBlockView })));

// CopilotKit only needs the arguments as an object; the real check is the catalog schema below.
const anyArgs = z.record(z.string(), z.unknown());

// A choice or a form answers with an ordinary message of the person, after which it is inactive.
function useAnswer(toolCallId: string): { answer: string | null; send: (text: string) => void } {
  const { agent } = useAgent();
  const { copilotkit } = useCopilotKit();
  const answer = answerOf(agent.messages, toolCallId);
  const send = useCallback(
    (text: string) => {
      agent.addMessage({ id: crypto.randomUUID(), role: 'user', content: text });
      void copilotkit.runAgent({ agent });
    },
    [agent, copilotkit],
  );
  return { answer, send };
}

function Choice({ call }: { call: CallProps }) {
  const { answer, send } = useAnswer(call.toolCallId);
  const parsed = choiceBlockSchema.safeParse(call.parameters);
  if (call.status === 'inProgress') return <Preparing ofCall />;
  if (!parsed.success) return <BrokenData data={call.parameters} />;
  return <ChoiceBlockView block={parsed.data} answer={answer} onAnswer={send} />;
}

function Form({ call }: { call: CallProps }) {
  const { answer, send } = useAnswer(call.toolCallId);
  const parsed = formBlockSchema.safeParse(call.parameters);
  if (call.status === 'inProgress') return <Preparing ofCall />;
  if (!parsed.success) return <BrokenData data={call.parameters} />;
  return <FormBlockView block={parsed.data} answered={answer !== null} onAnswer={send} />;
}

// The file block needs the conversation: «Скачать» takes the file from its folder.
function FileOfCall({ call }: { call: CallProps }) {
  const { threadId, draft } = useChatExtras();
  return <FileCall call={call} threadId={threadId} samples={!draft} />;
}

export function useGenuiRenderers(agent: AgentSummary): void {
  useRenderTool({ name: GENUI_TOOL.table, parameters: anyArgs, render: (call) => <CatalogBlock call={call} schema={modelTableBlockSchema} View={TableBlockView} /> }, []);
  useRenderTool(
    {
      name: GENUI_TOOL.chart,
      parameters: anyArgs,
      render: (call) => (
        <Suspense fallback={<Preparing />}>
          <CatalogBlock call={call} schema={chartBlockSchema} View={ChartBlockView} />
        </Suspense>
      ),
    },
    [],
  );
  useRenderTool({ name: GENUI_TOOL.card, parameters: anyArgs, render: (call) => <CatalogBlock call={call} schema={cardBlockSchema} View={CardBlockView} /> }, []);
  useRenderTool({ name: GENUI_TOOL.choice, parameters: anyArgs, render: (call) => <Choice call={call} /> }, []);
  useRenderTool({ name: GENUI_TOOL.form, parameters: anyArgs, render: (call) => <Form call={call} /> }, []);
  useRenderTool({ name: GENUI_TOOL.file, parameters: anyArgs, render: (call) => <FileOfCall call={call} /> }, []);
  // A widget of the agent (spec, section 8.31).
  useRenderTool({ name: WIDGET_TOOL.render, parameters: anyArgs, render: (call) => <WidgetCall call={call} /> }, []);
  // The live block of a search of the internet (spec, section 8.30).
  useRenderTool({ name: WEB_RESEARCH_TOOL, parameters: anyArgs, render: (call) => <WebSearch call={call} /> }, []);
  useRenderTool(
    {
      name: '*',
      render: (call: { name: string; status: CallProps['status']; parameters?: unknown; args?: unknown; result?: string }) => (
        <ToolRow name={call.name} status={call.status} parameters={call.parameters ?? call.args} result={call.result} agent={agent} />
      ),
    },
    [agent],
  );
}
