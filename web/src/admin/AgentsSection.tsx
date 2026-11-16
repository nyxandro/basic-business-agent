// «Агенты и промпты» (spec, scenario 5; owner's list 16.11): the agents as a list — the mark, the name,
// the departments and a mark of an edited prompt; a click opens the agent's page (AgentPage.tsx).
// Below: agents that departments still point at but the installation no longer has, and tasks
// stopped because of that.
import { Link } from 'react-router';
import { AgentMarkView } from '../chat/AgentMark.tsx';
import { ru } from '../i18n/ru.ts';
import { Card, EmptyState, PageHead, Pill } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { chatMarkOf } from './AgentMarkEditor.tsx';
import { agentPath } from './AgentPage.tsx';
import { adminApi } from './api.ts';
import styles from './agents.module.css';
import section from './section.module.css';

const t = ru.admin.agents;

async function load() {
  const [agents, tasks] = await Promise.all([adminApi.agents(), adminApi.tasks()]);
  return { ...agents, stopped: tasks.tasks.filter((task) => task.pausedReason === 'agent_missing') };
}

export function AgentsSection() {
  const { state, reload } = useLoad(load);
  const head = <PageHead title={t.title} lead={t.lead} />;
  if (state.status === 'loading') return <div className={section.stack}>{head}<Skeleton rows={4} /></div>;
  if (state.status === 'error') return <div className={section.stack}>{head}<ErrorBanner error={state.error} onRetry={reload} /></div>;
  const { agents, missingAgents, stopped } = state.data;
  return (
    <div className={section.stack}>
      {head}
      {missingAgents.length > 0 ? (
        <div className={styles.missing} role="alert">
          <strong>Агенты, которых больше нет.</strong> Отделы ссылаются на агентов, которых нет в установке: {missingAgents.join(', ')}. Уберите их в разделе «Отделы».
        </div>
      ) : null}
      {agents.length === 0 ? (
        <Card>
          <EmptyState title={t.emptyTitle} text={t.emptyText} />
        </Card>
      ) : (
        <ul className={styles.list} aria-label={t.listLabel}>
          {agents.map((a) => (
            <li key={a.id}>
              <Link to={agentPath(a.id)} className={`${styles.agent} rise`}>
                <AgentMarkView mark={chatMarkOf(a.mark)} />
                <span className={styles.agentText}>
                  <span className={styles.agentName}>{a.name}</span>
                  <span className={styles.agentDepts}>{a.departmentNames.length > 0 ? a.departmentNames.join(', ') : t.noDepartments}</span>
                </span>
                {a.promptChanged ? <Pill tone="warn">{t.changed}</Pill> : null}
                <Icon name="right" size={16} className={styles.agentGo} />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {stopped.length > 0 ? (
        <Card className={styles.stopped}>
          <div className={styles.stoppedTitle}>Задачи остановлены</div>
          <p className={section.note}>Агента больше нет в установке — эти задачи на паузе.</p>
          <ul className={styles.stoppedList}>
            {stopped.map((task) => (
              <li key={task.id}>
                <strong>{task.title}</strong> <span className={section.sub}>· агент {task.agentId}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
