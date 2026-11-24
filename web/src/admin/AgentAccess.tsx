// «Доступ» on the page of an agent (owner's decision 24.11, spec section 8.15): who may use the agent — and so its skills.
// «Вся организация», or «Отделы» and «Сотрудники» — both at once, as the owner asked: the department and a person by
// name. A list that is closed is forgotten, so nothing hidden stays chosen. The departments are the same link as
// «Агенты отдела» on a department's card.
import type { AdminAgent, AdminDepartment, AdminPerson, AgentAccess as Access } from '@bba/contracts';
import { useState } from 'react';
import { ru } from '../i18n/ru.ts';
import { Button, cx } from '../ui/Button.tsx';
import { Card, CardHead } from '../ui/Display.tsx';
import { Checklist, Feedback, useAction } from '../ui/form-parts.tsx';
import chips from '../ui/chips.module.css';
import { adminApi } from './api.ts';
import styles from './agents.module.css';
import section from './section.module.css';

const t = ru.admin.agents.access;

// In the order of the lists of the page; a removed department or person is not named.
const namesOf = (ids: string[], all: { id: string; name: string }[]) =>
  all
    .filter((x) => ids.includes(x.id))
    .map((x) => x.name)
    .join(', ');

// One line for the list of agents and the head of the page.
export function agentAccessText(access: Access, departments: AdminDepartment[], people: AdminPerson[]): string {
  if (access.org) return t.org;
  const parts = [namesOf(access.departmentIds, departments), namesOf(access.userIds, people)];
  const lines = [parts[0] ? t.summaryDepartments(parts[0]) : null, parts[1] ? t.summaryPeople(parts[1]) : null].filter((x): x is string => x !== null);
  return lines.length > 0 ? lines.join(' · ') : t.nobody;
}

type Open = { departments: boolean; people: boolean };
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

// «Вся организация» covers the lists: a department card may still tick an agent open to everyone, and its row must not
// show as a second choice — pressing «Отделы» then would close the agent to everyone.
const startOf = (a: Access): Access => (a.org ? { org: true, departmentIds: [], userIds: [] } : a);

export function AgentAccess({ agent, departments, people, onChanged }: { agent: AdminAgent; departments: AdminDepartment[]; people: AdminPerson[]; onChanged: () => void }) {
  const start = startOf(agent.access);
  const [access, setAccess] = useState<Access>(start);
  const [open, setOpen] = useState<Open>({ departments: start.departmentIds.length > 0, people: start.userIds.length > 0 });
  const { busy, error, run } = useAction();
  const dirty = access.org !== start.org || !sameList(access.departmentIds, start.departmentIds) || !sameList(access.userIds, start.userIds);
  const nobody = !access.org && access.departmentIds.length === 0 && access.userIds.length === 0;

  function chooseOrg() {
    setOpen({ departments: false, people: false });
    setAccess({ org: true, departmentIds: [], userIds: [] });
  }
  function toggle(list: keyof Open) {
    const on = !open[list];
    setOpen({ ...open, [list]: on });
    const field = list === 'departments' ? 'departmentIds' : 'userIds';
    setAccess({ ...access, org: false, [field]: on ? access[field] : [] });
  }
  async function save() {
    if (await run(() => adminApi.setAgentAccess(agent.id, access), t.saved)) onChanged();
  }

  return (
    <Card className="rise">
      <CardHead title={t.title} sub={t.sub} />
      <div className={styles.settingsBody}>
        <div role="group" aria-label={t.title} className={chips.row}>
          <button type="button" aria-pressed={access.org} className={cx(chips.chip, access.org && chips.on)} onClick={chooseOrg}>
            {t.org}
          </button>
          <button type="button" aria-pressed={open.departments} className={cx(chips.chip, open.departments && chips.on)} onClick={() => toggle('departments')}>
            {t.departments}
          </button>
          <button type="button" aria-pressed={open.people} className={cx(chips.chip, open.people && chips.on)} onClick={() => toggle('people')}>
            {t.people}
          </button>
        </div>
        {open.departments ? (
          <Checklist legend={t.departments} items={departments.map((d) => ({ id: d.id, label: d.name }))} selected={access.departmentIds} onChange={(departmentIds) => setAccess({ ...access, departmentIds })} />
        ) : null}
        {open.people ? <Checklist legend={t.people} items={people.map((p) => ({ id: p.id, label: p.name }))} selected={access.userIds} onChange={(userIds) => setAccess({ ...access, userIds })} /> : null}
        {nobody ? <p className={section.note}>{t.nobodyHint}</p> : null}
        {access.org ? <p className={section.note}>{t.orgHint}</p> : null}
        <Feedback error={error} />
        {dirty ? (
          <div className={styles.inline}>
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              {t.save}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
