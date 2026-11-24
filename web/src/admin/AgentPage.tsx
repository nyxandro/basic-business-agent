// The page of an agent (owner's list 16.11): its mark, name, description and who may use it, and its
// settings by sections, each saved on its own — «Инструкции» (the prompt over instructions.md, the
// draft, the check in the chat, the publication), «Настройки» (the model and the starters of the
// empty chat), «Скиллы» and «Доступ» (owner's decision 24.11: skills belong to the agent, people get
// them through its access), «Значок» (an icon or a picture). Every section has its own address, so
// «Назад» of the browser and a link lead to it. One route serves them all and every section stays
// mounted while hidden: a prompt or starters typed and not saved survive a look at another section.
import type { AdminAgent, AdminDepartment, AdminPerson, PromptState } from '@bba/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, useParams } from 'react-router';
import { AgentMarkView } from '../chat/AgentMark.tsx';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { ErrorBanner, Notice } from '../ui/ErrorBanner.tsx';
import { Icon } from '../ui/Icon.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { AgentAccess, agentAccessText } from './AgentAccess.tsx';
import { AgentInstructions } from './AgentInstructions.tsx';
import { AgentMarkEditor, chatMarkOf } from './AgentMarkEditor.tsx';
import { AgentSettings } from './AgentSettings.tsx';
import { AgentSkills } from './AgentSkills.tsx';
import { adminApi } from './api.ts';
import styles from './agents.module.css';
import section from './section.module.css';

const t = ru.admin.agents;

export type AgentTab = 'instructions' | 'settings' | 'skills' | 'access' | 'mark';
const TABS: { tab: AgentTab; suffix: string }[] = [
  { tab: 'instructions', suffix: '' },
  { tab: 'settings', suffix: '/settings' },
  { tab: 'skills', suffix: '/skills' },
  { tab: 'access', suffix: '/access' },
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
  const own = tab === 'instructions' || tab === 'settings';
  if (state.status === 'loading') return own ? <DelayedBar /> : null;
  if (state.status === 'error') return own ? <ErrorBanner error={state.error} onRetry={reload} /> : null;
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

function Head({ agent, who, tab }: { agent: AdminAgent; who: string; tab: AgentTab }) {
  // On a phone the five sections are wider than the screen: the open one stays in sight.
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [tab]);
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
          <p className={section.sub}>{who}</p>
        </div>
      </div>
      <nav ref={nav} aria-label={t.tabsLabel} className={styles.tabs}>
        {TABS.map(({ tab }) => (
          <NavLink key={tab} to={agentPath(agent.id, tab)} end className={({ isActive }) => cx(styles.tab, isActive && styles.tabOn)}>
            {t.tabs[tab]}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

// The agents with the departments, people and skills their access and skills are chosen from.
async function load() {
  const [agents, departments, people, skills] = await Promise.all([adminApi.agents(), adminApi.departments(), adminApi.people(), adminApi.skills()]);
  return { ...agents, departments: departments.departments, people: people.people, skills: skills.skills };
}

function Lists({ agent, tab, departments, people, skills, onChanged }: { agent: AdminAgent; tab: AgentTab; departments: AdminDepartment[]; people: AdminPerson[]; skills: Awaited<ReturnType<typeof load>>['skills']; onChanged: () => void }) {
  // A saved choice comes back with the list: the form starts from it anew.
  return (
    <>
      <div hidden={tab !== 'skills'}>
        <AgentSkills key={`skills:${agent.skillNames.join('|')}`} agent={agent} skills={skills} onChanged={onChanged} />
      </div>
      <div hidden={tab !== 'access'}>
        <AgentAccess key={`access:${JSON.stringify(agent.access)}`} agent={agent} departments={departments} people={people} onChanged={onChanged} />
      </div>
    </>
  );
}

export function AgentPage() {
  const { agentId, tab: segment } = useParams();
  if (!agentId) throw new Error('AgentPage needs the :agentId route parameter');
  // The settings, the skills, the access and the mark of the agent are forms over these lists: loaded anew at every opening.
  const { state, reload } = useLoad(load);
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
  const { departments, people, skills } = state.data;
  return (
    <div className={section.stack}>
      <Head agent={agent} who={agentAccessText(agent.access, departments, people)} tab={tab} />
      <PromptSections key={`prompt:${agent.id}`} agent={agent} tab={tab} onChanged={reload} />
      <Lists agent={agent} tab={tab} departments={departments} people={people} skills={skills} onChanged={reload} />
      <div hidden={tab !== 'mark'}>
        <AgentMarkEditor key={`mark:${agent.id}`} agent={agent} onSaved={reload} />
      </div>
    </div>
  );
}
