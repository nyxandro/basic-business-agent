// Draws the catalog blocks and every other tool call inside CopilotChat (spec, section 17.8).
import { cardBlockSchema, chartBlockSchema, choiceBlockSchema, formBlockSchema, GENUI_TOOL, modelTableBlockSchema, type AgentSummary } from '@bba/contracts';
import { useAgent, useCopilotKit, useRenderTool } from '@copilotkit/react-core';
import { lazy, Suspense, useCallback } from 'react';
import { z } from 'zod';
import { ToolRow } from '../chat/ToolRow.tsx';
import { BrokenData } from './BrokenData.tsx';
import { CardBlockView } from './CardBlock.tsx';
import { CatalogBlock, Preparing, type CallProps } from './CatalogBlock.tsx';
import { ChoiceBlockView } from './ChoiceBlock.tsx';
import { FormBlockView } from './FormBlock.tsx';
import { TableBlockView } from './TableBlock.tsx';

// A chart is drawn by code most conversations never need: it is loaded with the first chart.
const ChartBlockView = lazy(() => import('./ChartBlock.tsx').then((m) => ({ default: m.ChartBlockView })));

// CopilotKit only needs the arguments as an object; the real check is the catalog schema below.
const anyArgs = z.record(z.string(), z.unknown());

// A choice or a form answers with an ordinary message of the person, after which it is inactive.
function useAnswer(toolCallId: string): { answered: boolean; send: (text: string) => void } {
  const { agent } = useAgent();
  const { copilotkit } = useCopilotKit();
  const index = agent.messages.findIndex((m) => m.role === 'assistant' && (m.toolCalls ?? []).some((c) => c.id === toolCallId));
  const answered = index >= 0 && agent.messages.slice(index + 1).some((m) => m.role === 'user');
  const send = useCallback(
    (text: string) => {
      agent.addMessage({ id: crypto.randomUUID(), role: 'user', content: text });
      void copilotkit.runAgent({ agent });
    },
    [agent, copilotkit],
  );
  return { answered, send };
}

function Choice({ call }: { call: CallProps }) {
  const { answered, send } = useAnswer(call.toolCallId);
  const parsed = choiceBlockSchema.safeParse(call.parameters);
  if (call.status === 'inProgress') return <Preparing />;
  if (!parsed.success) return <BrokenData data={call.parameters} />;
  return <ChoiceBlockView block={parsed.data} answered={answered} onAnswer={send} />;
}

function Form({ call }: { call: CallProps }) {
  const { answered, send } = useAnswer(call.toolCallId);
  const parsed = formBlockSchema.safeParse(call.parameters);
  if (call.status === 'inProgress') return <Preparing />;
  if (!parsed.success) return <BrokenData data={call.parameters} />;
  return <FormBlockView block={parsed.data} answered={answered} onAnswer={send} />;
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
