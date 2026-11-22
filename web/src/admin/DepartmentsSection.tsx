// «Отделы» (spec, scenario 5; mockup): a card per department — its people and its agents; a person
// sees the agents of their departments. The card opens the editor.
import type { AdminDepartment, AdminUser } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { Button } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, EmptyState, IconTile, PageHead, initials } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { plural } from '../ui/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { Modal } from '../ui/Modal.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { Checklist, Feedback, useAction } from './parts.tsx';
import styles from './people.module.css';
import section from './section.module.css';

type Option = { id: string; label: string };
const SHOWN_FACES = 4;

const peopleCount = (n: number) => `${n} ${plural(n, ['сотрудник', 'сотрудника', 'сотрудников'])}`;

function Faces({ ids, users }: { ids: string[]; users: Map<string, AdminUser> }) {
  if (ids.length === 0) return null;
  const rest = ids.length - SHOWN_FACES;
  return (
    <div className={styles.faces} aria-hidden="true">
      {ids.slice(0, SHOWN_FACES).map((id) => (
        <span key={id} className={styles.face}>
          {initials(users.get(id)?.name ?? '?')}
        </span>
      ))}
      {rest > 0 ? <span className={styles.face}>+{rest}</span> : null}
    </div>
  );
}

function DepartmentEditor({ dep, people, agents, onClose, onChanged }: { dep: AdminDepartment; people: Option[]; agents: Option[]; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState(dep.name);
  const [userIds, setUserIds] = useState(dep.userIds);
  // «Руководители» approve at a stage «руководитель отдела сотрудника» (docs/specs/[20.11.2026]-multi-step-approvals.md, F1).
  const [headIds, setHeadIds] = useState(dep.headIds);
  const [agentIds, setAgentIds] = useState(dep.agentIds);
  const { busy, error, run } = useAction();
  const confirm = useConfirm();
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

  async function save() {
    const ok = await run(async () => {
      if (name.trim() !== dep.name) await adminApi.renameDepartment(dep.id, name.trim());
      if (!same(userIds, dep.userIds)) await adminApi.setDepartmentMembers(dep.id, userIds);
      if (!same(agentIds, dep.agentIds)) await adminApi.setDepartmentAgents(dep.id, agentIds);
      const heads = headIds.filter((id) => userIds.includes(id));
      if (!same(heads, dep.headIds)) await adminApi.setDepartmentHeads(dep.id, heads);
    });
    if (ok) {
      onChanged();
      onClose();
    }
  }
  async function remove() {
    if (!(await confirm({ title: `Удалить отдел «${dep.name}»?`, text: 'Сотрудники останутся, но потеряют агентов этого отдела.', confirmLabel: 'Удалить', danger: true }))) return;
    if (await run(() => adminApi.deleteDepartment(dep.id), 'Отдел удалён')) {
      onChanged();
      onClose();
    }
  }

  return (
    <Modal open onClose={onClose} label={dep.name}>
      <form
        className={section.form}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 className={section.formTitle}>{dep.name}</h2>
        <Feedback error={error} />
        <Field label="Название">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Checklist legend="Сотрудники" items={people} selected={userIds} onChange={setUserIds} />
        <Checklist legend="Руководители" items={people.filter((p) => userIds.includes(p.id))} selected={headIds.filter((id) => userIds.includes(id))} onChange={setHeadIds} />
        <Checklist legend="Агенты отдела" items={agents} selected={agentIds} onChange={setAgentIds} />
        <div className={section.formActions}>
          <Button variant="danger" icon="trash" disabled={busy} onClick={() => void remove()} className={styles.pushLeft}>
            Удалить отдел
          </Button>
          <Button onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            Сохранить
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function NewDepartment({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Modal open onClose={onClose} label="Новый отдел" narrow>
      <form
        className={section.form}
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => adminApi.createDepartment(name.trim()), 'Отдел создан').then((ok) => ok && onCreated());
        }}
      >
        <h2 className={section.formTitle}>Новый отдел</h2>
        <Feedback error={error} />
        <Field label="Название">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className={section.formActions}>
          <Button onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            Создать отдел
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function DepartmentsSection() {
  const load = useCallback(async () => {
    const [deps, users, agents] = await Promise.all([adminApi.departments(), adminApi.users(), adminApi.agents()]);
    return { departments: deps.departments, users: users.users, agents: agents.agents };
  }, []);
  const { state, reload } = useLoad(load, ['admin', 'departments-page']);
  const [editing, setEditing] = useState<AdminDepartment | null>(null);
  const [creating, setCreating] = useState(false);

  const head = (
    <PageHead
      title="Отделы"
      lead="Сотрудник видит агентов своего отдела."
      actions={
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          Новый отдел
        </Button>
      }
    />
  );
  if (state.status === 'loading') return <div className={section.stack}>{head}<DelayedBar /></div>;
  if (state.status === 'error') return <div className={section.stack}>{head}<ErrorBanner error={state.error} onRetry={reload} /></div>;
  const users = new Map(state.data.users.map((u) => [u.id, u]));
  const people = state.data.users.map((u) => ({ id: u.id, label: u.name }));
  const agents = state.data.agents.map((a) => ({ id: a.id, label: a.name }));
  const agentName = new Map(state.data.agents.map((a) => [a.id, a.name]));
  return (
    <div className={section.stack}>
      {head}
      {state.data.departments.length === 0 ? (
        <Card>
          <EmptyState title="Отделов пока нет" text="Создайте первый и назначьте ему агентов." />
        </Card>
      ) : (
        <div className={styles.grid}>
          {state.data.departments.map((d, i) => (
            <button key={d.id} type="button" className={`${styles.dept} rise`} style={{ animationDelay: `${Math.min(i, 8) * 0.05}s` }} onClick={() => setEditing(d)} aria-label={`Отдел ${d.name}: изменить`}>
              <span className={styles.deptHead}>
                <IconTile icon="building" size={40} />
                <span>
                  <span className={styles.deptName}>{d.name}</span>
                  <span className={styles.deptSub}>{peopleCount(d.userIds.length)}</span>
                </span>
              </span>
              <Faces ids={d.userIds} users={users} />
              <span>
                <span className={styles.label}>Агенты</span>
                <span className={styles.tags}>
                  {d.agentIds.length === 0 ? <span className={styles.none}>не назначены</span> : null}
                  {d.agentIds.map((id) => (
                    <span key={id} className={styles.tag}>
                      {agentName.get(id) ?? id}
                    </span>
                  ))}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {editing ? <DepartmentEditor key={editing.id} dep={editing} people={people} agents={agents} onClose={() => setEditing(null)} onChanged={reload} /> : null}
      {creating ? (
        <NewDepartment
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}
