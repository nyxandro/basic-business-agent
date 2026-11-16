// «Роли» (spec, scenario 5; mockup): a table of rights — the sections of the admin panel by roles.
// A mark saves at once; the built-in roles (the superadmin with everything, the employee without
// the admin panel) do not change. No role reads others' conversations.
import { PERMISSIONS, type AdminRole, type Permission } from '@bba/contracts';
import { useState } from 'react';
import { Button, cx, IconButton } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, PageHead } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { Icon } from '../ui/Icon.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { Menu, MenuAnchor, MenuItem } from '../ui/Menu.tsx';
import { Modal } from '../ui/Modal.tsx';
import { Table } from '../ui/Table.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { Feedback, useAction } from './parts.tsx';
import styles from './people.module.css';
import { PERMISSION_LABELS } from './sections.ts';
import section from './section.module.css';

const BUILTIN_NOTE = 'Встроенная роль не меняется';

function NameDialog({ title, initial, submit, onClose, onDone }: { title: string; initial: string; submit: (name: string) => Promise<unknown>; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(initial);
  const { busy, error, run } = useAction();
  return (
    <Modal open onClose={onClose} label={title} narrow>
      <form
        className={section.form}
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => submit(name.trim())).then((ok) => ok && onDone());
        }}
      >
        <h2 className={section.formTitle}>{title}</h2>
        <Feedback error={error} />
        <Field label="Название роли">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className={section.formActions}>
          <Button onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            Сохранить
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RoleHead({ role, onRename, onChanged }: { role: AdminRole; onRename: () => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const confirm = useConfirm();
  const { error, run } = useAction();
  const label = `Роль ${role.name}: действия`;
  return (
    <div className={styles.roleHead}>
      <span className={styles.roleName}>
        {role.name}
        <span className={styles.roleCount}>{role.userCount}</span>
      </span>
      {role.builtin ? null : (
        <MenuAnchor>
          <IconButton icon="dots" size="sm" label={label} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} />
          <Menu open={open} onClose={() => setOpen(false)} label={label} width={200} floating>
            <MenuItem
              icon="edit"
              onSelect={() => {
                setOpen(false);
                onRename();
              }}
            >
              Переименовать
            </MenuItem>
            <MenuItem
              icon="trash"
              danger
              onSelect={() => {
                setOpen(false);
                void confirm({ title: `Удалить роль «${role.name}»?`, text: role.userCount > 0 ? 'Сотрудники с этой ролью потеряют открытые ею разделы.' : undefined, confirmLabel: 'Удалить', danger: true }).then(async (yes) => {
                  if (yes && (await run(() => adminApi.deleteRole(role.id), 'Роль удалена'))) onChanged();
                });
              }}
            >
              Удалить
            </MenuItem>
          </Menu>
        </MenuAnchor>
      )}
      <Feedback error={error} />
    </div>
  );
}

// One save at a time: a mark waits while the previous one is saved, so the server keeps what the
// screen shows.
function Mark({ role, right, busy, onToggle }: { role: AdminRole; right: Permission; busy: boolean; onToggle: () => void }) {
  const locked = role.builtin !== null;
  const on = role.builtin === 'superadmin' || role.permissions.includes(right);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-disabled={locked}
      aria-label={`${role.name}: ${PERMISSION_LABELS[right] ?? right}`}
      title={locked ? BUILTIN_NOTE : undefined}
      className={cx(styles.mark, on && styles.markOn, locked && styles.markLocked)}
      aria-busy={busy || undefined}
      onClick={locked || busy ? undefined : onToggle}
    >
      <Icon name="check" size={14} />
    </button>
  );
}

export function RolesSection() {
  const { state, reload } = useLoad(adminApi.roles, ['admin', 'roles']);
  const [roles, setRoles] = useState<AdminRole[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<AdminRole | null>(null);
  const { busy, error, run } = useAction();

  const head = (
    <PageHead
      title="Роли"
      lead="Роль открывает разделы админки. Переписку сотрудников не видит ни одна роль."
      actions={
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          Новая роль
        </Button>
      }
    />
  );
  if (state.status === 'loading') return <div className={section.stack}>{head}<DelayedBar /></div>;
  if (state.status === 'error') return <div className={section.stack}>{head}<ErrorBanner error={state.error} onRetry={reload} /></div>;
  // Marks change in place at once; a failed save puts the mark back. The superadmin goes first and
  // the employee last, as in the mockup.
  const order = (r: AdminRole) => (r.builtin === 'superadmin' ? 0 : r.builtin === 'employee' ? 2 : 1);
  const shown = [...(roles ?? state.data.roles)].sort((a, b) => order(a) - order(b));
  async function toggle(role: AdminRole, right: Permission) {
    const permissions = role.permissions.includes(right) ? role.permissions.filter((p) => p !== right) : [...role.permissions, right];
    const before = shown;
    setRoles(shown.map((r) => (r.id === role.id ? { ...r, permissions } : r)));
    if (!(await run(() => adminApi.updateRole(role.id, role.name, permissions)))) setRoles(before);
  }
  const refresh = () => {
    setRoles(null);
    reload();
  };

  return (
    <div className={section.stack}>
      {head}
      <Feedback error={error} />
      <Card className={`${section.tableCard} rise`}>
        <Table minWidth={160 + shown.length * 150} label="Права ролей">
          <thead>
            <tr>
              <th scope="col">Раздел</th>
              {shown.map((r) => (
                <th key={r.id} scope="col" className={styles.roleCol}>
                  <RoleHead role={r} onRename={() => setRenaming(r)} onChanged={refresh} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSIONS.map((p) => (
              <tr key={p}>
                <td>{PERMISSION_LABELS[p] ?? p}</td>
                {shown.map((r) => (
                  <td key={r.id} className={styles.markCell}>
                    <Mark role={r} right={p} busy={busy} onToggle={() => void toggle(r, p)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <p className={section.note}>Число рядом с ролью — сколько у неё сотрудников. {BUILTIN_NOTE}: у суперадминистратора открыто всё, у сотрудника — только чат.</p>
      {creating ? (
        <NameDialog
          title="Новая роль"
          initial=""
          submit={(name) => adminApi.createRole(name, [])}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            refresh();
          }}
        />
      ) : null}
      {renaming ? (
        <NameDialog
          title="Переименовать роль"
          initial={renaming.name}
          submit={(name) => adminApi.updateRole(renaming.id, name, (shown.find((r) => r.id === renaming.id) ?? renaming).permissions)}
          onClose={() => setRenaming(null)}
          onDone={() => {
            setRenaming(null);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}
