// «Проверить в чате» (spec, scenario 5): the saved draft of the prompt answers here; the check has
// its own memory and conversations, the spend goes to the admin who checks.
import { CopilotKit } from '@copilotkit/react-core';
import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import { COPILOT_OPTIONS } from '../app/copilot.ts';
import { ChatPanel } from '../chat/ChatPanel.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';

// The server serves the draft version when this header comes with the CopilotKit requests.
const DRAFT_HEADERS = { 'x-bba-draft': '1' };
// Tools of a draft check are named as they are; system names are for the employees' chat.
const NO_SYSTEMS = { tools: {}, prefixes: {} };

export function DraftCheckPage() {
  const { agentId } = useParams();
  if (!agentId) throw new Error('DraftCheckPage needs the :agentId route parameter');
  const { state, reload } = useLoad(adminApi.agents);
  const [threadId] = useState(() => crypto.randomUUID());
  const noop = useCallback(() => undefined, []);
  if (state.status === 'loading') return <Skeleton rows={3} />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const agent = state.data.agents.find((a) => a.id === agentId);
  if (!agent) return <p className="banner banner-error">Этот агент больше не доступен.</p>;
  return (
    <div>
      <h1>Проверка черновика: {agent.name}</h1>
      <p className="muted">
        Отвечает сохранённый черновик промпта. <Link to="/admin/agents">Вернуться к агентам</Link>
      </p>
      <CopilotKit {...COPILOT_OPTIONS} headers={DRAFT_HEADERS}>
        <ChatPanel agent={{ id: agent.id, name: agent.name, description: agent.description, starters: [], actions: {}, systems: NO_SYSTEMS }} threadId={threadId} onRunFinished={noop} />
      </CopilotKit>
    </div>
  );
}
