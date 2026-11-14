// «Отделы» (spec, scenario 5): each department gets its people and its agents.
import type { AdminDepartment } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { Checklist, Feedback, useAction } from './parts.tsx';

type Option = { id: string; label: string };

function DepartmentEditor({ dep, people, agents, onChanged }: { dep: AdminDepartment; people: Option[]; agents: Option[]; onChanged: () => void }) {
  const [name, setName] = useState(dep.name);
  const [userIds, setUserIds] = useState(dep.userIds);
  const [agentIds, setAgentIds] = useState(dep.agentIds);
  const { busy, error, run } = useAction();
  const act = async (action: () => Promise<unknown>, done?: string) => {
    if (await run(action, done)) onChanged();
  };
  return (
    <div className="admin-form">
      <Feedback error={error} />
      <label>
        Название
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="button" disabled={busy || !name.trim()} onClick={() => void act(() => adminApi.renameDepartment(dep.id, name.trim()))}>
        Переименовать
      </button>
      <Checklist legend="Сотрудники" items={people} selected={userIds} onChange={setUserIds} />
      <button type="button" disabled={busy} onClick={() => void act(() => adminApi.setDepartmentMembers(dep.id, userIds))}>
        Сохранить сотрудников
      </button>
      <Checklist legend="Агенты отдела" items={agents} selected={agentIds} onChange={setAgentIds} />
      <button type="button" disabled={busy} onClick={() => void act(() => adminApi.setDepartmentAgents(dep.id, agentIds))}>
        Сохранить агентов
      </button>
      <button
        type="button"
        className="secondary danger"
        disabled={busy}
        onClick={() => {
          if (window.confirm(`Удалить отдел «${dep.name}»? Сотрудники останутся, но потеряют агентов этого отдела.`)) void act(() => adminApi.deleteDepartment(dep.id), 'Отдел удалён');
        }}
      >
        Удалить отдел
      </button>
    </div>
  );
}

export function DepartmentsSection() {
  const load = useCallback(async () => {
    const [deps, users, agents] = await Promise.all([adminApi.departments(), adminApi.users(), adminApi.agents()]);
    return { departments: deps.departments, users: users.users, agents: agents.agents };
  }, []);
  const { state, reload } = useLoad(load);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState('');
  const create = useAction();

  if (state.status === 'loading') return <Skeleton rows={3} />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const people = state.data.users.map((u) => ({ id: u.id, label: `${u.name} (${u.email})` }));
  const agents = state.data.agents.map((a) => ({ id: a.id, label: a.name }));
  const agentName = new Map(state.data.agents.map((a) => [a.id, a.name]));
  return (
    <div>
      <h1>Отделы</h1>
      {state.data.departments.length === 0 ? <p className="empty">Отделов пока нет. Создайте первый и назначьте ему агентов.</p> : null}
      <ul className="plain-list">
        {state.data.departments.map((d) => (
          <li key={d.id} className="card-block">
            <div className="row-line">
              <strong>{d.name}</strong>
              <span className="muted">
                сотрудников: {d.userIds.length} · агенты: {d.agentIds.map((id) => agentName.get(id) ?? id).join(', ') || 'нет'}
              </span>
              <button type="button" className="link-button" onClick={() => setOpen(open === d.id ? null : d.id)}>
                Изменить
              </button>
            </div>
            {open === d.id ? <DepartmentEditor key={d.id} dep={d} people={people} agents={agents} onChanged={reload} /> : null}
          </li>
        ))}
      </ul>
      <h2>Новый отдел</h2>
      <div className="admin-form">
        <Feedback error={create.error} />
        <label>
          Название
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={create.busy || !name.trim()}
          onClick={() =>
            void create.run(() => adminApi.createDepartment(name.trim()), 'Отдел создан').then((ok) => {
              if (ok) {
                setName('');
                reload();
              }
            })
          }
        >
          Создать отдел
        </button>
      </div>
    </div>
  );
}
