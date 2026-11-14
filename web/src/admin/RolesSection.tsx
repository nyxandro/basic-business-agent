// «Роли» (spec, scenario 5): a role opens admin sections; no role reads others' conversations.
import { PERMISSIONS, type AdminRole, type Permission } from '@bba/contracts';
import { useState } from 'react';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { Checklist, Feedback, useAction } from './parts.tsx';
import { PERMISSION_LABELS } from './sections.ts';

const RIGHTS = PERMISSIONS.map((p) => ({ id: p, label: PERMISSION_LABELS[p] ?? p }));

function RoleForm({ role, onSaved }: { role: AdminRole | null; onSaved: () => void }) {
  const [name, setName] = useState(role?.name ?? '');
  const [permissions, setPermissions] = useState<string[]>(role?.permissions ?? []);
  const { busy, error, run } = useAction();
  const save = async () => {
    const chosen = permissions as Permission[];
    const ok = await run(() => (role ? adminApi.updateRole(role.id, name.trim(), chosen) : adminApi.createRole(name.trim(), chosen)));
    if (ok) {
      if (!role) {
        setName('');
        setPermissions([]);
      }
      onSaved();
    }
  };
  const remove = async () => {
    if (role && window.confirm(`Удалить роль «${role.name}»?`) && (await run(() => adminApi.deleteRole(role.id), 'Роль удалена'))) onSaved();
  };
  return (
    <div className="admin-form">
      <Feedback error={error} />
      <label>
        Название роли
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <Checklist legend="Разделы админки" items={RIGHTS} selected={permissions} onChange={setPermissions} />
      <div className="row-buttons">
        <button type="button" disabled={busy || !name.trim()} onClick={() => void save()}>
          {role ? 'Сохранить' : 'Создать роль'}
        </button>
        {role ? (
          <button type="button" className="secondary danger" disabled={busy} onClick={() => void remove()}>
            Удалить роль
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function RolesSection() {
  const { state, reload } = useLoad(adminApi.roles);
  const [open, setOpen] = useState<string | null>(null);
  if (state.status === 'loading') return <Skeleton rows={3} />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  return (
    <div>
      <h1>Роли</h1>
      <p className="muted">Переписки сотрудников не видит никакая роль.</p>
      <ul className="plain-list">
        {state.data.roles.map((r) => (
          <li key={r.id} className="card-block">
            <div className="row-line">
              <strong>{r.name}</strong>
              <span className="muted">
                {r.builtin === 'superadmin' ? 'все разделы' : r.permissions.map((p) => PERMISSION_LABELS[p] ?? p).join(', ') || 'без разделов админки'} · сотрудников: {r.userCount}
              </span>
              {r.builtin ? null : (
                <button type="button" className="link-button" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  Изменить
                </button>
              )}
            </div>
            {open === r.id ? <RoleForm key={r.id} role={r} onSaved={reload} /> : null}
          </li>
        ))}
      </ul>
      <h2>Новая роль</h2>
      <RoleForm role={null} onSaved={reload} />
    </div>
  );
}
