// «Проверить в чате» (spec, scenario 5): the saved draft of the prompt answers here; the check has
// its own memory and conversations, the spend goes to the admin who checks.
import { CopilotKit } from '@copilotkit/react-core';
import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import { COPILOT_OPTIONS } from '../app/copilot.ts';
import { ChatPanel } from '../chat/ChatPanel.tsx';
import { chatMarkOf } from './AgentMarkEditor.tsx';
import { agentPath } from './AgentPage.tsx';
import { Card, PageHead } from '../ui/Display.tsx';
import { ErrorBanner, Notice } from '../ui/ErrorBanner.tsx';
import { Icon } from '../ui/Icon.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import styles from './agents.module.css';
import { adminApi } from './api.ts';
import section from './section.module.css';

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
  if (state.status === 'loading') return <DelayedBar />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const agent = state.data.agents.find((a) => a.id === agentId);
  if (!agent) return <Notice>Этот агент больше не доступен.</Notice>;
  return (
    <div className={section.stack}>
      <PageHead
        title={`Проверка черновика: ${agent.name}`}
        lead="Отвечает сохранённый черновик промпта. Расход идёт на вас, у проверки своя память."
        actions={
          <Link to={agentPath(agent.id)} className={styles.check}>
            <Icon name="back" size={16} />
            Вернуться к агенту
          </Link>
        }
      />
      <Card className={styles.checkChat}>
        <CopilotKit {...COPILOT_OPTIONS} headers={DRAFT_HEADERS}>
          <ChatPanel agent={{ id: agent.id, name: agent.name, description: agent.description, starters: agent.starters, mark: chatMarkOf(agent.mark), actions: {}, systems: NO_SYSTEMS }} threadId={threadId} onRunFinished={noop} onThreadTitled={noop} />
        </CopilotKit>
      </Card>
    </div>
  );
}
