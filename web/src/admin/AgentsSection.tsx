// «Агенты и промпты» (spec, scenario 5; mockup): the agents as cards — departments and a mark of an
// edited prompt; the chosen one opens in the editor beside them. Below: agents that departments
// still point at but the installation no longer has, and tasks stopped because of that.
import type { AdminAgent } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { cx } from '../ui/Button.tsx';
import { Card, EmptyState, IconTile, PageHead, Pill } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { AgentEditor } from './AgentEditor.tsx';
import { adminApi } from './api.ts';
import styles from './agents.module.css';
import section from './section.module.css';

function AgentPanel({ agent, onChanged }: { agent: AdminAgent; onChanged: () => void }) {
  const load = useCallback(() => adminApi.prompt(agent.id), [agent.id]);
  const { state, reload } = useLoad(load);
  if (state.status === 'loading') return <Skeleton rows={6} />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const changed = () => {
    reload();
    onChanged();
  };
  // A new key after publish, revert or another model: the editor shows the fresh version.
  return <AgentEditor key={`${state.data.publishedAt ?? 'file'}:${state.data.draftVersionId ?? ''}:${state.data.modelId ?? ''}:${agent.starters.join('|')}`} agent={agent} state={state.data} onChanged={changed} />;
}

export function AgentsSection() {
  const load = useCallback(async () => {
    const [agents, tasks] = await Promise.all([adminApi.agents(), adminApi.tasks()]);
    return { ...agents, stopped: tasks.tasks.filter((t) => t.pausedReason === 'agent_missing') };
  }, []);
  const { state, reload } = useLoad(load);
  const [chosen, setChosen] = useState<string | null>(null);
  const head = <PageHead title="Агенты и промпты" lead="Правка промпта поверх файла агента: черновик, проверка в чате, публикация." />;
  if (state.status === 'loading') return <div className={section.stack}>{head}<Skeleton rows={4} /></div>;
  if (state.status === 'error') return <div className={section.stack}>{head}<ErrorBanner error={state.error} onRetry={reload} /></div>;
  const { agents, missingAgents, stopped } = state.data;
  const current = agents.find((a) => a.id === chosen) ?? agents[0];
  return (
    <div className={section.stack}>
      {head}
      {missingAgents.length > 0 ? (
        <div className={styles.missing} role="alert">
          <strong>Агенты, которых больше нет.</strong> Отделы ссылаются на агентов, которых нет в установке: {missingAgents.join(', ')}. Уберите их в разделе «Отделы».
        </div>
      ) : null}
      {!current ? (
        <Card>
          <EmptyState title="В установке нет агентов" text="Агенты ставятся вместе с установкой: папка agents/ на сервере." />
        </Card>
      ) : (
        <div className={styles.layout}>
          <ul className={styles.list} aria-label="Агенты">
            {agents.map((a) => (
              <li key={a.id} className={styles.agentItem}>
                <button type="button" aria-current={a.id === current.id ? 'true' : undefined} className={cx(styles.agent, a.id === current.id && styles.agentOn)} onClick={() => setChosen(a.id)}>
                  <span className={styles.agentHead}>
                    <IconTile icon="bot" size={32} />
                    <span className={styles.agentText}>
                      <span className={styles.agentName}>{a.name}</span>
                      <span className={styles.agentDepts}>{a.departmentNames.length > 0 ? a.departmentNames.join(', ') : 'Не назначен отделам'}</span>
                    </span>
                  </span>
                  {a.promptChanged ? <Pill tone="warn">Изменён в админке</Pill> : null}
                </button>
              </li>
            ))}
          </ul>
          <div className={styles.panel}>
            <AgentPanel key={current.id} agent={current} onChanged={reload} />
          </div>
        </div>
      )}
      {stopped.length > 0 ? (
        <Card className={styles.stopped}>
          <div className={styles.stoppedTitle}>Задачи остановлены</div>
          <p className={section.note}>Агента больше нет в установке — эти задачи на паузе.</p>
          <ul className={styles.stoppedList}>
            {stopped.map((t) => (
              <li key={t.id}>
                <strong>{t.title}</strong> <span className={section.sub}>· агент {t.agentId}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
