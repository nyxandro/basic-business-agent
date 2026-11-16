// «Сотрудники» (spec, scenario 5; mockup): invites, the people with department, role, spend of the
// month against the limit (with the rights to see them) and state; search, a department filter and
// the menu of each row. Invites waiting for an answer are rows «Приглашён».
import type { AdminDepartment, AdminInvite, AdminRole, AdminUser, IssuedLink, MeResponse } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { useMe } from '../auth/session.tsx';
import { useMedia, WIDE_QUERY } from '../layout/use-media.ts';
import { Button, IconButton } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Avatar, Card, EmptyState, PageHead, Pill, Progress } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { SearchInput, Select } from '../ui/Field.tsx';
import { dateTime, plural, rub } from '../ui/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { Menu, MenuAnchor, MenuItem, MenuSeparator } from '../ui/Menu.tsx';
import { Table } from '../ui/Table.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { monthStart, today } from './dates.ts';
import { InviteDialog } from './InviteForm.tsx';
import { CopyLink, Feedback, useAction } from './parts.tsx';
import { hasRight } from './sections.ts';
import styles from './section.module.css';
import { RESET_CREATED, UserEditor } from './UserEditor.tsx';

// The bar turns amber from here: most of the month's money is spent.
const WARN_SHARE = 0.8;

interface Spend {
  spent: Map<string, number> | null;
  limitOf: ((userId: string) => number | null) | null;
}

async function loadSpend(me: MeResponse): Promise<Spend> {
  const [usage, limits, personal] = await Promise.all([
    hasRight(me, 'usage') ? adminApi.usage(monthStart(), today(), 'user') : null,
    hasRight(me, 'limits') ? adminApi.limits() : null,
    hasRight(me, 'limits') ? adminApi.personalLimits() : null,
  ]);
  const own = new Map((personal?.users ?? []).map((p) => [p.userId, p.monthlyRub]));
  return {
    spent: usage ? new Map(usage.rows.map((r) => [r.key, r.costRub])) : null,
    limitOf: limits ? (id) => own.get(id) ?? limits.defaultUserMonthlyRub : null,
  };
}

type Row = { kind: 'user'; user: AdminUser } | { kind: 'invite'; invite: AdminInvite };

function SpendCell({ spent, limit }: { spent: number | undefined; limit: number | null | undefined }) {
  if (spent === undefined && limit === undefined) return null;
  const value = spent ?? 0;
  const text = limit ? `${rub(value)} из ${rub(limit)}` : rub(value);
  const share = limit ? value / limit : null;
  return (
    <div className={styles.spend}>
      <div className={styles.spendText}>{text}</div>
      {share !== null ? <Progress value={share} tone={share >= 1 ? 'bad' : share >= WARN_SHARE ? 'warn' : 'accent'} label={`Расход: ${text}`} height={5} /> : null}
    </div>
  );
}

function StatePill({ row }: { row: Row }) {
  if (row.kind === 'invite') return <Pill tone="accent">Приглашён</Pill>;
  return row.user.blocked ? <Pill tone="bad">Заблокирован</Pill> : <Pill tone="ok">Активен</Pill>;
}

function RowMenu({ row, onEdit, onChanged, onLink }: { row: Row; onEdit: (u: AdminUser) => void; onChanged: () => void; onLink: (link: IssuedLink) => void }) {
  const [open, setOpen] = useState(false);
  const confirm = useConfirm();
  const { error, run } = useAction();
  const act = async (action: () => Promise<unknown>, done: string | null) => {
    setOpen(false);
    if (await run(action, done)) onChanged();
  };
  const name = row.kind === 'user' ? row.user.name : row.invite.name;
  const label = `Действия: ${name}`;
  return (
    <MenuAnchor>
      <IconButton icon="dots" label={label} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} />
      <Menu open={open} onClose={() => setOpen(false)} label={label} width={230} floating>
        {row.kind === 'invite' ? (
          <MenuItem icon="x" danger onSelect={() => void act(() => adminApi.revokeInvite(row.invite.id), 'Приглашение отозвано')}>
            Отозвать приглашение
          </MenuItem>
        ) : (
          <>
            <MenuItem
              icon="edit"
              onSelect={() => {
                setOpen(false);
                onEdit(row.user);
              }}
            >
              Изменить
            </MenuItem>
            <MenuItem icon="key" onSelect={() => void act(async () => onLink(await adminApi.resetPassword(row.user.id)), null)}>
              Сбросить пароль
            </MenuItem>
            <MenuItem icon="lock" onSelect={() => void act(() => adminApi.setBlocked(row.user.id, !row.user.blocked), row.user.blocked ? 'Разблокирован' : 'Заблокирован')}>
              {row.user.blocked ? 'Разблокировать' : 'Заблокировать'}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon="trash"
              danger
              onSelect={() => {
                setOpen(false);
                void confirm({ title: `Удалить сотрудника ${row.user.name}?`, text: deleteUserText(row.user), confirmLabel: 'Удалить', danger: true }).then(async (yes) => {
                  if (yes) await act(() => adminApi.deleteUser(row.user.id), 'Сотрудник удалён');
                });
              }}
            >
              Удалить
            </MenuItem>
          </>
        )}
      </Menu>
      <Feedback error={error} />
    </MenuAnchor>
  );
}

interface Data {
  users: AdminUser[];
  roles: AdminRole[];
  departments: AdminDepartment[];
  invites: AdminInvite[];
  spend: Spend;
}

// What goes with the employee, and that their projects come to the administrator who removes them
// (spec, section 8.20; decisions of the owner 16.11).
function deleteUserText(user: AdminUser): string {
  const base = 'Удалятся его доступы, разговоры, память и рабочая папка. Журнал действий сохранится.';
  const { total, shared } = user.projects;
  if (total === 0) return base;
  const projects = `${total} ${plural(total, ['проект', 'проекта', 'проектов'])}`;
  const ofThem = shared > 0 ? `, из них общих — ${shared}` : '';
  return `${base} Его проекты (${projects}${ofThem}) перейдут вам: вы станете их создателем${shared > 0 ? ', коллеги сохранят доступ к общим' : ''}.`;
}

export function UsersSection() {
  const me = useMe();
  const wide = useMedia(WIDE_QUERY);
  const load = useCallback(async (): Promise<Data> => {
    const [users, roles, departments, invites, spend] = await Promise.all([adminApi.users(), adminApi.roles(), adminApi.departments(), adminApi.invites(), loadSpend(me)]);
    return { users: users.users, roles: roles.roles, departments: departments.departments, invites: invites.invites, spend };
  }, [me]);
  const { state, reload } = useLoad(load, ['admin', 'users-page']);
  const [query, setQuery] = useState('');
  const [department, setDepartment] = useState('');
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [link, setLink] = useState<{ text: string; link: string } | null>(null);

  const head = (
    <PageHead
      title="Сотрудники"
      lead="Приглашения, роли, отделы и личные лимиты. Переписку сотрудников администратор не видит."
      actions={
        <Button variant="primary" icon="plus" onClick={() => setInviting(true)} disabled={state.status !== 'ready'}>
          Пригласить
        </Button>
      }
    />
  );
  if (state.status === 'loading') return <div className={styles.stack}>{head}<DelayedBar /></div>;
  if (state.status === 'error') return <div className={styles.stack}>{head}<ErrorBanner error={state.error} onRetry={reload} /></div>;
  const { users, roles, departments, invites, spend } = state.data;
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const depName = new Map(departments.map((d) => [d.id, d.name]));
  const q = query.trim().toLowerCase();
  const matches = (name: string, email: string) => !q || name.toLowerCase().includes(q) || email.toLowerCase().includes(q);
  const rows: Row[] = [
    ...users.filter((u) => matches(u.name, u.email) && (!department || u.departmentIds.includes(department))).map((user) => ({ kind: 'user' as const, user })),
    ...(department ? [] : invites.filter((i) => matches(i.name, i.email)).map((invite) => ({ kind: 'invite' as const, invite }))),
  ];
  const deptOf = (r: Row) => (r.kind === 'user' ? r.user.departmentIds.map((id) => depName.get(id) ?? id).join(', ') || '—' : '—');
  const roleOf = (r: Row) => (r.kind === 'user' ? r.user.roleIds.map((id) => roleName.get(id) ?? id).join(', ') : `до ${dateTime(r.invite.expiresAt)}`);
  const showSpend = spend.spent !== null || spend.limitOf !== null;
  const spendOf = (r: Row) => (r.kind === 'user' ? <SpendCell spent={spend.spent ? (spend.spent.get(r.user.id) ?? 0) : undefined} limit={spend.limitOf ? spend.limitOf(r.user.id) : undefined} /> : null);
  const menu = (r: Row) => <RowMenu row={r} onEdit={setEditing} onChanged={reload} onLink={(l) => setLink({ text: RESET_CREATED, link: l.link })} />;
  const key = (r: Row) => (r.kind === 'user' ? r.user.id : `invite-${r.invite.id}`);
  const nameOf = (r: Row) => (r.kind === 'user' ? r.user : r.invite);

  return (
    <div className={styles.stack}>
      {head}
      {link ? <CopyLink link={link.link} text={link.text} /> : null}
      <div className={`${styles.toolbar} rise`}>
        <SearchInput label="Поиск сотрудника" placeholder="Имя или почта" value={query} onChange={(e) => setQuery(e.target.value)} className={styles.search} />
        <Select aria-label="Отдел" value={department} onChange={(e) => setDepartment(e.target.value)} className={styles.filter}>
          <option value="">Все отделы</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
      </div>
      {rows.length === 0 ? (
        <Card>
          <EmptyState title="Никого не нашлось" text="Попробуйте другое имя или выберите все отделы." />
        </Card>
      ) : wide ? (
        <Card className={`${styles.tableCard} rise`}>
          <Table minWidth={760} label="Сотрудники">
            <thead>
              <tr>
                <th scope="col">Сотрудник</th>
                <th scope="col">Отдел</th>
                <th scope="col">Роль</th>
                {showSpend ? <th scope="col">Расход / лимит</th> : null}
                <th scope="col">Статус</th>
                <th scope="col">
                  <span className="visually-hidden">Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={key(r)}>
                  <td>
                    <div className={styles.personCell}>
                      <Avatar name={nameOf(r).name} size={32} />
                      <div>
                        <div className={styles.personName}>{nameOf(r).name}</div>
                        <div className={styles.sub}>{nameOf(r).email}</div>
                      </div>
                    </div>
                  </td>
                  <td>{deptOf(r)}</td>
                  <td>{roleOf(r)}</td>
                  {showSpend ? <td>{spendOf(r)}</td> : null}
                  <td>
                    <StatePill row={r} />
                  </td>
                  <td className={styles.actionsCell}>{menu(r)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : (
        <div className={styles.cards}>
          {rows.map((r) => (
            <div key={key(r)} className={`${styles.cardRow} rise`}>
              <Avatar name={nameOf(r).name} size={38} />
              <div className={styles.cardMain}>
                <div className={styles.personName}>{nameOf(r).name}</div>
                <div className={styles.sub}>
                  {deptOf(r)} · {roleOf(r)}
                </div>
              </div>
              <StatePill row={r} />
              {menu(r)}
            </div>
          ))}
        </div>
      )}
      <InviteDialog
        open={inviting}
        roles={roles}
        departments={departments}
        onClose={() => setInviting(false)}
        onCreated={(issued, text) => {
          setInviting(false);
          setLink({ text, link: issued.link });
          reload();
        }}
      />
      {editing ? <UserEditor key={editing.id} user={editing} roles={roles} onClose={() => setEditing(null)} onChanged={reload} /> : null}
    </div>
  );
}
