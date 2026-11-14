// «Пользователи» (spec, scenario 5): invites, the list of people, one person's settings.
import { useCallback, useState } from 'react';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dateTime } from '../ui/format.ts';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { InviteForm } from './InviteForm.tsx';
import { Feedback, useAction } from './parts.tsx';
import { UserEditor } from './UserEditor.tsx';

export function UsersSection() {
  const load = useCallback(async () => {
    const [users, roles, departments, invites] = await Promise.all([adminApi.users(), adminApi.roles(), adminApi.departments(), adminApi.invites()]);
    return { users: users.users, roles: roles.roles, departments: departments.departments, invites: invites.invites };
  }, []);
  const { state, reload } = useLoad(load);
  const [open, setOpen] = useState<string | null>(null);
  const revoke = useAction();

  if (state.status === 'loading') return <Skeleton rows={4} />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const { users, roles, departments, invites } = state.data;
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const depName = new Map(departments.map((d) => [d.id, d.name]));

  return (
    <div>
      <h1>Пользователи</h1>
      <InviteForm roles={roles} departments={departments} onCreated={reload} />
      {invites.length > 0 ? (
        <>
          <h2>Приглашения ждут ответа</h2>
          <Feedback error={revoke.error} notice={revoke.notice} />
          <ul className="plain-list">
            {invites.map((i) => (
              <li key={i.id} className="row-line">
                <span>
                  {i.name} · {i.email} · до {dateTime(i.expiresAt)}
                </span>
                <button type="button" className="secondary" disabled={revoke.busy} onClick={() =>
                    void revoke.run(() => adminApi.revokeInvite(i.id), 'Приглашение отозвано').then((ok) => {
                      if (ok) reload();
                    })
                  }>
                  Отозвать
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h2>Сотрудники</h2>
      <div className="table-scroll">
        <table className="admin-table">
          <thead>
            <tr>
              <th scope="col">Сотрудник</th>
              <th scope="col">Роли</th>
              <th scope="col">Отделы</th>
              <th scope="col">Состояние</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <button type="button" className="link-button" onClick={() => setOpen(open === u.id ? null : u.id)}>
                    {u.name}
                  </button>
                  <div className="muted">
                    {u.email}
                    {u.position ? ` · ${u.position}` : ''}
                  </div>
                  {open === u.id ? <UserEditor key={u.id} user={u} roles={roles} onChanged={reload} /> : null}
                </td>
                <td>{u.roleIds.map((id) => roleName.get(id) ?? id).join(', ')}</td>
                <td>{u.departmentIds.map((id) => depName.get(id) ?? id).join(', ') || '—'}</td>
                <td>{u.blocked ? 'Заблокирован' : 'Активен'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
