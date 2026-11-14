// «Агенты» (spec, scenario 5): prompts and models; agents that departments still point at but
// the installation no longer has; background tasks left without an owner.
import { useCallback, useState } from 'react';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dateTime } from '../ui/format.ts';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { PromptEditor } from './PromptEditor.tsx';

function AgentPrompt({ agentId }: { agentId: string }) {
  const load = useCallback(() => adminApi.prompt(agentId), [agentId]);
  const { state, reload } = useLoad(load);
  const [done, setDone] = useState<string | null>(null);
  if (state.status === 'loading') return <Skeleton rows={4} />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const changed = (text: string) => {
    setDone(text);
    reload();
  };
  return (
    <>
      {done ? (
        <p className="banner banner-ok" role="status">
          {done}
        </p>
      ) : null}
      {/* A new key after publish or revert: the field shows the fresh version. */}
      <PromptEditor key={`${state.data.publishedAt ?? 'file'}:${state.data.draftVersionId ?? ''}`} state={state.data} onChanged={changed} />
    </>
  );
}

export function AgentsSection() {
  const load = useCallback(async () => {
    const [agents, tasks] = await Promise.all([adminApi.agents(), adminApi.tasks()]);
    return { ...agents, stopped: tasks.tasks.filter((t) => t.pausedReason === 'agent_missing') };
  }, []);
  const { state, reload } = useLoad(load);
  const [open, setOpen] = useState<string | null>(null);
  if (state.status === 'loading') return <Skeleton rows={3} />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  return (
    <div>
      <h1>Агенты</h1>
      <ul className="plain-list">
        {state.data.agents.map((a) => (
          <li key={a.id} className="card-block">
            <div className="row-line">
              <strong>{a.name}</strong>
              <span className="muted">
                {a.description}
                {a.modelId ? ` · своя модель ${a.modelId}` : ''}
              </span>
              <button type="button" className="link-button" onClick={() => setOpen(open === a.id ? null : a.id)}>
                Промпт
              </button>
            </div>
            {open === a.id ? <AgentPrompt agentId={a.id} /> : null}
          </li>
        ))}
      </ul>
      {state.data.missingAgents.length > 0 ? (
        <div className="banner banner-error">
          <p className="banner-title">Агенты, которых больше нет</p>
          <p>Отделы ссылаются на агентов, которых нет в установке: {state.data.missingAgents.join(', ')}. Уберите их из отделов.</p>
        </div>
      ) : null}
      {state.data.stopped.length > 0 ? (
        <>
          <h2>Задачи остановлены</h2>
          <p className="muted">Агента больше нет в установке — задача приостановлена.</p>
          <ul className="plain-list">
            {state.data.stopped.map((t) => (
              <li key={t.id} className="row-line">
                <strong>{t.title}</strong>
                <span className="muted">
                  агент {t.agentId} · расписание {t.cron} · последний запуск {t.lastFire ? dateTime(t.lastFire.fireAt) : '—'}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
