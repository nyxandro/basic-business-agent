// Invite (spec, scenario 5): the link lives 7 days; the admin copies it and sends it.
import type { AdminDepartment, AdminRole, IssuedLink } from '@bba/contracts';
import { useState, type SubmitEvent } from 'react';
import { Button } from '../ui/Button.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { Modal } from '../ui/Modal.tsx';
import { adminApi } from './api.ts';
import { Checklist, Feedback, useAction } from './parts.tsx';
import styles from './section.module.css';

export const INVITE_CREATED = 'Приглашение создано. Ссылка действует 7 дней — отправьте её сотруднику.';

function InviteForm({ roles, departments, onClose, onCreated }: { roles: AdminRole[]; departments: AdminDepartment[]; onClose: () => void; onCreated: (issued: IssuedLink, text: string) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const employee = roles.find((r) => r.builtin === 'employee');
  const [roleIds, setRoleIds] = useState<string[]>(employee ? [employee.id] : []);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const { busy, error, run } = useAction();

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    let issued: IssuedLink | null = null;
    const ok = await run(async () => {
      issued = await adminApi.invite({ email: email.trim(), name: name.trim(), roleIds, departmentIds });
    }, null);
    if (ok && issued) onCreated(issued, INVITE_CREATED);
  }

  return (
    <form className={styles.form} onSubmit={(e) => void submit(e)}>
      <h2 className={styles.formTitle}>Пригласить сотрудника</h2>
      <Feedback error={error} />
      <div className={styles.row}>
        <Field label="Почта">
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Имя">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
      <Checklist legend="Роли" items={roles.map((r) => ({ id: r.id, label: r.name }))} selected={roleIds} onChange={setRoleIds} />
      <Checklist legend="Отделы" items={departments.map((d) => ({ id: d.id, label: d.name }))} selected={departmentIds} onChange={setDepartmentIds} />
      <div className={styles.formActions}>
        <Button onClick={onClose}>Отмена</Button>
        <Button type="submit" variant="primary" disabled={busy || roleIds.length === 0}>
          Создать приглашение
        </Button>
      </div>
    </form>
  );
}

export function InviteDialog(props: { open: boolean; roles: AdminRole[]; departments: AdminDepartment[]; onClose: () => void; onCreated: (issued: IssuedLink, text: string) => void }) {
  return (
    <Modal open={props.open} onClose={props.onClose} label="Пригласить сотрудника">
      {props.open ? <InviteForm {...props} /> : null}
    </Modal>
  );
}
