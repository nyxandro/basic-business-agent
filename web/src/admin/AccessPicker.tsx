// «Кому доступен»: the whole organisation, departments or employees (spec, sections 8.15 and 8.16)
// — for skills and background tasks. The lists matter for the last two only.
import type { AdminDepartment, AdminPerson, SkillAccess, SkillScope } from '@bba/contracts';
import { cx } from '../ui/Button.tsx';
import { Checklist } from '../ui/form-parts.tsx';
import styles from './models.module.css';
import chips from '../ui/chips.module.css';

const SCOPES: { value: SkillScope; label: string }[] = [
  { value: 'org', label: 'Вся организация' },
  { value: 'departments', label: 'Отделы' },
  { value: 'users', label: 'Сотрудники' },
];

export function accessText(access: SkillAccess, departments: AdminDepartment[], users: AdminPerson[]): string {
  if (access.scope === 'org') return 'Вся организация';
  if (access.scope === 'departments') return `Отделы: ${access.departmentIds.map((id) => departments.find((d) => d.id === id)?.name ?? id).join(', ')}`;
  return `Сотрудники: ${access.userIds.map((id) => users.find((u) => u.id === id)?.name ?? id).join(', ')}`;
}

// A scope with nobody chosen gives the skill or the task to no one: the server refuses it too.
export const accessIsEmpty = (a: SkillAccess) => (a.scope === 'departments' && a.departmentIds.length === 0) || (a.scope === 'users' && a.userIds.length === 0);

export function AccessPicker({ value, onChange, departments, users, legend = 'Кому доступен' }: { value: SkillAccess; onChange: (next: SkillAccess) => void; departments: AdminDepartment[]; users: AdminPerson[]; legend?: string }) {
  return (
    <fieldset className={styles.prices}>
      <legend className={styles.legend}>{legend}</legend>
      <div role="group" aria-label={legend} className={chips.row}>
        {SCOPES.map((s) => (
          <button key={s.value} type="button" aria-pressed={value.scope === s.value} className={cx(chips.chip, value.scope === s.value && chips.on)} onClick={() => onChange({ ...value, scope: s.value })}>
            {s.label}
          </button>
        ))}
      </div>
      {value.scope === 'departments' ? (
        <div className={styles.pickList}>
          <Checklist legend="Отделы" items={departments.map((d) => ({ id: d.id, label: d.name }))} selected={value.departmentIds} onChange={(departmentIds) => onChange({ ...value, departmentIds })} />
        </div>
      ) : null}
      {value.scope === 'users' ? (
        <div className={styles.pickList}>
          <Checklist legend="Сотрудники" items={users.map((u) => ({ id: u.id, label: u.name }))} selected={value.userIds} onChange={(userIds) => onChange({ ...value, userIds })} />
        </div>
      ) : null}
    </fieldset>
  );
}
