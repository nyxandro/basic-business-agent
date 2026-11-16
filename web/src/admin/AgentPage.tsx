// The page of an agent (owner's list 16.11): its mark, name, description and departments, and its
// settings by sections, each saved on its own — «Инструкции» (the prompt over instructions.md, the
// draft, the check in the chat, the publication), «Настройки» (the model and the starters of the
// empty chat), «Значок» (an icon or a picture). Every section has its own address, so «Назад» of the
// browser and a link lead to it. One route serves them all and every section stays mounted while
// hidden: a prompt or starters typed and not saved survive a look at another section.
import type { AdminAgent, PromptState } from '@bba/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, useParams } from 'react-router';
import { AgentMarkView } from '../chat/AgentMark.tsx';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { ErrorBanner, Notice } from '../ui/ErrorBanner.tsx';
import { Icon } from '../ui/Icon.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { AgentInstructions } from './AgentInstructions.tsx';
import { AgentMarkEditor, chatMarkOf } from './AgentMarkEditor.tsx';
import { AgentSettings } from './AgentSettings.tsx';
import { adminApi } from './api.ts';
import styles from './agents.module.css';
import section from './section.module.css';

const t = ru.admin.agents;

export type AgentTab = 'instructions' | 'settings' | 'mark';
const TABS: { tab: AgentTab; suffix: string }[] = [
  { tab: 'instructions', suffix: '' },
  { tab: 'settings', suffix: '/settings' },
  { tab: 'mark', suffix: '/mark' },
];

export const agentPath = (agentId: string, tab: AgentTab = 'instructions') => `/admin/agents/${encodeURIComponent(agentId)}${TABS.find((x) => x.tab === tab)!.suffix}`;

// The frame of the admin panel starts a page anew at every new address; the sections of an agent
// are one page, so they share its key.
export function agentPageKey(pathname: string): string {
  const match = /^(\/admin\/agents\/[^/]+)(\/[^/]+)?$/.exec(pathname);
  return match && TABS.some((x) => x.suffix === (match[2] ?? '')) ? match[1]! : pathname;
}

function tabOf(segment: string | undefined): AgentTab | null {
  if (segment === undefined) return 'instructions';
  return TABS.find((x) => x.suffix === `/${segment}`)?.tab ?? null;
}

// The prompt and the model come from their own address; the rest of the agent from the list.
function PromptSections({ agent, tab, onChanged }: { agent: AdminAgent; tab: AgentTab; onChanged: () => void }) {
  const load = useCallback(() => adminApi.prompt(agent.id), [agent.id]);
  // A form starts from what it loads: loaded anew at every opening, never from memory (spec, section 8.22).
  const { state, reload } = useLoad(load);
  // The prompt field is drawn anew only after «Опубликовать» or «Вернуть версию из файла», once
  // their fresh version has come: a saved draft, a new model or new starters keep the text being
  // typed in it.
  const [edition, setEdition] = useState(0);
  const awaiting = useRef<PromptState | null>(null);
  const data = state.status === 'ready' ? state.data : null;
  useEffect(() => {
    if (!awaiting.current || !data || data === awaiting.current) return;
    awaiting.current = null;
    setEdition((n) => n + 1);
  }, [data]);
  // Hidden, not gone, on another section: the prompt or the starters being typed wait there.
  if (state.status === 'loading') return tab === 'mark' ? null : <DelayedBar />;
  if (state.status === 'error') return tab === 'mark' ? null : <ErrorBanner error={state.error} onRetry={reload} />;
  const changed = () => {
    reload();
    onChanged();
  };
  const published = () => {
    awaiting.current = state.data;
    changed();
  };
  return (
    <>
      <div hidden={tab !== 'instructions'}>
        <AgentInstructions key={edition} state={state.data} onChanged={published} />
      </div>
      <div hidden={tab !== 'settings'}>
        <AgentSettings agent={agent} state={state.data} onChanged={changed} />
      </div>
    </>
  );
}

function Head({ agent }: { agent: AdminAgent }) {
  return (
    <div className={styles.pageHead}>
      <Link to="/admin/agents" className={styles.back}>
        <Icon name="back" size={16} />
        {t.back}
      </Link>
      <div className={styles.identity}>
        <AgentMarkView mark={chatMarkOf(agent.mark)} size="large" />
        <div className={styles.identityText}>
          <h1 className={styles.identityName}>{agent.name}</h1>
          <p className={styles.identityLead}>{agent.description}</p>
          <p className={section.sub}>{agent.departmentNames.length > 0 ? agent.departmentNames.join(', ') : t.noDepartments}</p>
        </div>
      </div>
      <nav aria-label={t.tabsLabel} className={styles.tabs}>
        {TABS.map(({ tab }) => (
          <NavLink key={tab} to={agentPath(agent.id, tab)} end className={({ isActive }) => cx(styles.tab, isActive && styles.tabOn)}>
            {t.tabs[tab]}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export function AgentPage() {
  const { agentId, tab: segment } = useParams();
  if (!agentId) throw new Error('AgentPage needs the :agentId route parameter');
  // The settings and the mark of the agent are forms over this list: it is loaded anew at every opening.
  const { state, reload } = useLoad(adminApi.agents);
  const tab = tabOf(segment);
  if (!tab) return <Navigate to={agentPath(agentId)} replace />;
  if (state.status === 'loading') return <DelayedBar />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const agent = state.data.agents.find((a) => a.id === agentId);
  if (!agent) {
    return (
      <div className={section.stack}>
        <Notice>{t.gone}</Notice>
        <Link to="/admin/agents" className={styles.back}>
          <Icon name="back" size={16} />
          {t.back}
        </Link>
      </div>
    );
  }
  return (
    <div className={section.stack}>
      <Head agent={agent} />
      <PromptSections key={`prompt:${agent.id}`} agent={agent} tab={tab} onChanged={reload} />
      <div hidden={tab !== 'mark'}>
        <AgentMarkEditor key={`mark:${agent.id}`} agent={agent} onSaved={reload} />
      </div>
    </div>
  );
}
