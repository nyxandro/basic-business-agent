// One employee (spec, scenario 5): name and position, roles, a password reset link (24 hours),
// blocking, removal in steps (a repeat after a partial failure finishes the job).
import type { AdminRole, AdminUser, IssuedLink } from '@bba/contracts';
import { useState } from 'react';
import { adminApi } from './api.ts';
import { Checklist, CopyLink, Feedback, useAction } from './parts.tsx';

export const RESET_CREATED = 'Ссылка для смены пароля создана. Она действует 24 часа — отправьте её сотруднику.';

export function UserEditor({ user, roles, onChanged }: { user: AdminUser; roles: AdminRole[]; onChanged: () => void }) {
  const [name, setName] = useState(user.name);
  const [position, setPosition] = useState(user.position);
  const [roleIds, setRoleIds] = useState(user.roleIds);
  const [reset, setReset] = useState<IssuedLink | null>(null);
  const { busy, error, notice, run } = useAction();

  const act = async (action: () => Promise<unknown>, done?: string) => {
    if (await run(action, done)) onChanged();
  };
  const remove = () => {
    if (window.confirm(`Удалить сотрудника ${user.name}? Удалятся его доступы, разговоры, память и рабочая папка. Журнал действий сохранится.`)) {
      void act(() => adminApi.deleteUser(user.id), 'Сотрудник удалён');
    }
  };

  return (
    <div className="user-editor">
      <Feedback error={error} notice={notice} />
      {reset ? <CopyLink link={reset.link} text={RESET_CREATED} /> : null}
      <div className="admin-form">
        <label>
          Имя
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Должность
          <input value={position} onChange={(e) => setPosition(e.target.value)} />
        </label>
        <button type="button" disabled={busy || !name.trim()} onClick={() => void act(() => adminApi.setUserProfile(user.id, name.trim(), position.trim()))}>
          Сохранить профиль
        </button>
        <Checklist legend="Роли" items={roles.map((r) => ({ id: r.id, label: r.name }))} selected={roleIds} onChange={setRoleIds} />
        <button type="button" disabled={busy || roleIds.length === 0} onClick={() => void act(() => adminApi.setUserRoles(user.id, roleIds))}>
          Сохранить роли
        </button>
      </div>
      <div className="row-buttons">
        <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => setReset(await adminApi.resetPassword(user.id)), '')}>
          Сбросить пароль
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void act(() => adminApi.setBlocked(user.id, !user.blocked), user.blocked ? 'Разблокирован' : 'Заблокирован')}>
          {user.blocked ? 'Разблокировать' : 'Заблокировать'}
        </button>
        <button type="button" className="secondary danger" disabled={busy} onClick={remove}>
          Удалить
        </button>
      </div>
    </div>
  );
}
