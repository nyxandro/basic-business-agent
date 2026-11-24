// One employee (spec, scenario 5): name and position, roles. A reset link, blocking and removal
// live in the row's menu.
import type { AdminRole, AdminUser } from '@bba/contracts';
import { useState } from 'react';
import { Button } from '../ui/Button.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { Modal } from '../ui/Modal.tsx';
import { adminApi } from './api.ts';
import { Checklist, Feedback, useAction } from '../ui/form-parts.tsx';
import styles from './section.module.css';

export const RESET_CREATED = 'Ссылка для смены пароля создана. Она действует 24 часа — отправьте её сотруднику.';

export function UserEditor({ user, roles, onClose, onChanged }: { user: AdminUser; roles: AdminRole[]; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState(user.name);
  const [position, setPosition] = useState(user.position);
  const [roleIds, setRoleIds] = useState(user.roleIds);
  const { busy, error, run } = useAction();

  async function save() {
    const ok = await run(async () => {
      if (name.trim() !== user.name || position.trim() !== user.position) await adminApi.setUserProfile(user.id, name.trim(), position.trim());
      if (roleIds.join() !== user.roleIds.join()) await adminApi.setUserRoles(user.id, roleIds);
    });
    if (ok) {
      onChanged();
      onClose();
    }
  }

  return (
    <Modal open onClose={onClose} label={user.name}>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 className={styles.formTitle}>{user.name}</h2>
        <p className={styles.note}>{user.email}</p>
        <Feedback error={error} />
        <div className={styles.row}>
          <Field label="Имя">
            <Input required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Должность">
            <Input value={position} onChange={(e) => setPosition(e.target.value)} />
          </Field>
        </div>
        <Checklist legend="Роли" items={roles.map((r) => ({ id: r.id, label: r.name }))} selected={roleIds} onChange={setRoleIds} />
        <div className={styles.formActions}>
          <Button onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim() || roleIds.length === 0}>
            Сохранить
          </Button>
        </div>
      </form>
    </Modal>
  );
}
