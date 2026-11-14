// Invite (spec, scenario 5): the link lives 7 days; the admin copies it and sends it.
import type { AdminDepartment, AdminRole, IssuedLink } from '@bba/contracts';
import { useState, type SubmitEvent } from 'react';
import { adminApi } from './api.ts';
import { Checklist, CopyLink, Feedback, useAction } from './parts.tsx';

export const INVITE_CREATED = 'Приглашение создано. Ссылка действует 7 дней — отправьте её сотруднику.';

export function InviteForm({ roles, departments, onCreated }: { roles: AdminRole[]; departments: AdminDepartment[]; onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const employee = roles.find((r) => r.builtin === 'employee');
  const [roleIds, setRoleIds] = useState<string[]>(employee ? [employee.id] : []);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  const { busy, error, run } = useAction();

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setIssued(null);
    const ok = await run(async () => setIssued(await adminApi.invite({ email: email.trim(), name: name.trim(), roleIds, departmentIds })), '');
    if (ok) {
      setEmail('');
      setName('');
      onCreated();
    }
  }

  return (
    <form className="admin-form" onSubmit={(e) => void submit(e)}>
      <h2>Пригласить сотрудника</h2>
      <Feedback error={error} notice={null} />
      {issued ? <CopyLink link={issued.link} text={INVITE_CREATED} /> : null}
      <label>
        Почта
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        Имя
        <input required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <Checklist legend="Роли" items={roles.map((r) => ({ id: r.id, label: r.name }))} selected={roleIds} onChange={setRoleIds} />
      <Checklist legend="Отделы" items={departments.map((d) => ({ id: d.id, label: d.name }))} selected={departmentIds} onChange={setDepartmentIds} />
      <button type="submit" disabled={busy || roleIds.length === 0}>
        Создать приглашение
      </button>
    </form>
  );
}
