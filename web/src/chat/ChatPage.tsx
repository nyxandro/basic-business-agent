// /agents/:agentId?thread=… (spec, section 7): the conversations on the left, the chat on the right.
// Without ?thread a new conversation starts with a fresh id.
import { useCallback, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { fetchAgents } from '../agents/api.ts';
import { ru } from '../i18n/ru.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { ChatPanel } from './ChatPanel.tsx';
import { ThreadList } from './ThreadList.tsx';

export function ChatPage() {
  const { agentId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const threadId = params.get('thread');
  const { state, reload } = useLoad(fetchAgents);
  const [refreshKey, setRefreshKey] = useState(0);
  const onRunFinished = useCallback(() => setRefreshKey((n) => n + 1), []);

  if (!agentId) throw new Error('ChatPage needs the :agentId route parameter');
  if (!threadId) return <Navigate to={`?thread=${crypto.randomUUID()}`} replace />;
  if (state.status === 'loading') return <Skeleton rows={4} />;
  if (state.status === 'error') return <ErrorBanner title={ru.agents.loadFailed} error={state.error} onRetry={reload} />;
  const agent = state.data.agents.find((a) => a.id === agentId);
  if (!agent) return <p className="banner banner-error">{ru.chat.noAgent}</p>;

  const startNew = () => void navigate(`?thread=${crypto.randomUUID()}`);
  return (
    <div className="chat-layout">
      <ThreadList agentId={agent.id} currentThreadId={threadId} refreshKey={refreshKey} onNew={startNew} onDeleted={(id) => id === threadId && startNew()} />
      <section className="chat-main">
        <h1>{agent.name}</h1>
        <ChatPanel key={threadId} agent={agent} threadId={threadId} onRunFinished={onRunFinished} />
      </section>
    </div>
  );
}
