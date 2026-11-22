// «Режимы работы» (spec, scenario 4; mockup): how agents work — in the chat, on a schedule, on an
// event; the background tasks with their area, schedule, the last fire («Выполнено у 7 из 8») and
// a switch; the breakdown of a fire by people; the rules of the core nobody turns off.
import type { AdminAgent, AdminDepartment, AdminTask, AdminPerson } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { Button, IconButton } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, EmptyState, IconTile, PageHead, Pill } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { Menu, MenuAnchor, MenuItem, MenuSeparator } from '../ui/Menu.tsx';
import { Switch } from '../ui/Switch.tsx';
import { Table } from '../ui/Table.tsx';
import { useLoad } from '../ui/use-load.ts';
import { useMedia, WIDE_QUERY } from '../layout/use-media.ts';
import { accessText } from './AccessPicker.tsx';
import { ApprovalTerms } from './ApprovalTerms.tsx';
import { adminApi } from './api.ts';
import { Feedback, useAction } from './parts.tsx';
import section from './section.module.css';
import { TaskForm } from './TaskForm.tsx';
import { TaskEvents } from './TaskEvents.tsx';
import { TaskRuns } from './TaskRuns.tsx';
import styles from './tasks.module.css';
import { eventsText, lastFireText, pausedText, whenText } from './tasks-text.ts';

const RULES = [
  { name: 'Каждое действие наружу через «Да»', sub: 'В чате и в фоновых задачах. Постоянных разрешений нет.' },
  { name: 'У вопроса «Да» есть срок', sub: 'Срок задан в «Подтверждениях» выше. Потом действие не выполняется и попадает в «Не получилось».' },
  { name: 'Песочница без сети', sub: 'Скрипты скиллов работают в своей папке сотрудника.' },
];

function Modes({ agents, scheduled, onEvent }: { agents: number; scheduled: number; onEvent: number }) {
  const modes: { name: string; icon: IconName; count: number; desc: string }[] = [
    { name: 'В чате', icon: 'chat', count: agents, desc: 'Сотрудник пишет агенту, ответ текстом, таблицами, графиками и формами.' },
    { name: 'По расписанию', icon: 'clock', count: scheduled, desc: 'Запуск в заданное время без чата, результат в разговоре задачи у каждого сотрудника.' },
    { name: 'По событию', icon: 'bolt', count: onEvent, desc: 'Запуск, когда в почту сотрудника пришло подходящее письмо или другая система прислала сообщение на адрес задачи. Без интернета.' },
  ];
  return (
    <div className={`${styles.modes} rise`}>
      {modes.map((m) => (
        <Card key={m.name} className={styles.mode}>
          <div className={styles.modeHead}>
            <IconTile icon={m.icon} size={36} />
            <span className={styles.modeName}>{m.name}</span>
            <span className={styles.modeCount}>{m.count}</span>
          </div>
          <p className={styles.modeDesc}>{m.desc}</p>
        </Card>
      ))}
    </div>
  );
}

function TaskMenu({ task, onEdit, onRuns, onChanged }: { task: AdminTask; onEdit: () => void; onRuns: () => void; onChanged: () => void }) {
  const byEvent = task.trigger !== 'schedule';
  const [open, setOpen] = useState(false);
  const confirm = useConfirm();
  const { error, run } = useAction();
  const label = `Действия: ${task.title}`;
  return (
    <MenuAnchor>
      <IconButton icon="dots" label={label} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} />
      <Menu open={open} onClose={() => setOpen(false)} label={label} width={230} floating>
        <MenuItem icon="edit" onSelect={() => (setOpen(false), onEdit())}>
          Изменить
        </MenuItem>
        <MenuItem icon={byEvent ? 'bolt' : 'users'} onSelect={() => (setOpen(false), onRuns())}>
          {byEvent ? 'Последние события' : 'Разбивка по людям'}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon="trash"
          danger
          onSelect={() => {
            setOpen(false);
            void confirm({ title: `Удалить задачу «${task.title}»?`, text: 'Вопросы, которые ждут решения сотрудников, будут отклонены. Разговоры задачи у сотрудников останутся.', confirmLabel: 'Удалить', danger: true }).then(async (yes) => {
              if (yes && (await run(() => adminApi.deleteTask(task.id), 'Задача удалена'))) onChanged();
            });
          }}
        >
          Удалить
        </MenuItem>
      </Menu>
      <Feedback error={error} />
    </MenuAnchor>
  );
}

interface Data {
  tasks: AdminTask[];
  agents: AdminAgent[];
  departments: AdminDepartment[];
  users: AdminPerson[];
}

export function ModesSection() {
  const load = useCallback(async (): Promise<Data> => {
    const [tasks, agents, departments, users] = await Promise.all([adminApi.tasks(), adminApi.agents(), adminApi.departments(), adminApi.people()]);
    return { tasks: tasks.tasks, agents: agents.agents, departments: departments.departments, users: users.people };
  }, []);
  const { state, reload } = useLoad(load, ['admin', 'tasks-page']);
  const wide = useMedia(WIDE_QUERY);
  const [editing, setEditing] = useState<AdminTask | 'new' | null>(null);
  const [runsOf, setRunsOf] = useState<AdminTask | null>(null);
  const { error, run } = useAction();
  const head = <PageHead title="Режимы работы" lead="Агент отвечает в чате, работает по расписанию и по событию: письму в почте или сообщению другой системы — от имени сотрудника, с его доступами." />;
  if (state.status === 'loading') return <div className={section.stack}>{head}<DelayedBar /></div>;
  if (state.status === 'error') return <div className={section.stack}>{head}<ErrorBanner error={state.error} onRetry={reload} /></div>;
  const { tasks, agents, departments, users } = state.data;
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  // A webhook task works on behalf of its executor; the others — of everyone in their area.
  const whoText = (t: AdminTask) => (t.trigger === 'webhook' ? `от имени: ${t.executor?.name ?? 'исполнитель не выбран'}` : accessText(t.access, departments, users));
  const toggle = async (t: AdminTask, on: boolean) => {
    if (await run(() => adminApi.setTaskStatus(t.id, on ? 'active' : 'paused'), on ? 'Задача включена' : 'Задача на паузе')) reload();
  };

  return (
    <div className={section.stack}>
      {head}
      <Modes agents={agents.length} scheduled={tasks.filter((t) => t.trigger === 'schedule').length} onEvent={tasks.filter((t) => t.trigger !== 'schedule').length} />
      <Card className={`${section.tableCard} rise`}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>Фоновые задачи</h2>
          <Button variant="primary" icon="plus" disabled={agents.length === 0} onClick={() => setEditing('new')}>
            Новая задача
          </Button>
        </div>
        <div className={styles.inset}>
          <Feedback error={error} />
        </div>
        {tasks.length === 0 ? (
          <EmptyState title="Фоновых задач пока нет" text="Создайте первую." />
        ) : !wide ? (
          <ul className={styles.phoneList} aria-label="Фоновые задачи">
            {tasks.map((t) => {
              const paused = pausedText(t.pausedReason);
              return (
                <li key={t.id} className={styles.phoneTask}>
                  <div className={styles.phoneMain}>
                    <div className={styles.taskName}>{t.title}</div>
                    <div className={section.sub}>
                      {whenText(t)} · {whoText(t)}
                    </div>
                    <button type="button" className={styles.last} onClick={() => setRunsOf(t)}>
                      {t.events ? eventsText(t.events) : lastFireText(t.lastFire)}
                    </button>
                    {paused ? <Pill tone="warn">{paused}</Pill> : null}
                  </div>
                  <Switch size="lg" checked={t.status === 'active'} label={t.title} onChange={(on) => void toggle(t, on)} />
                  <TaskMenu task={t} onEdit={() => setEditing(t)} onRuns={() => setRunsOf(t)} onChanged={reload} />
                </li>
              );
            })}
          </ul>
        ) : (
          <Table minWidth={820} label="Фоновые задачи">
            <thead>
              <tr>
                <th scope="col">Задача</th>
                <th scope="col">Агент</th>
                <th scope="col">Когда</th>
                <th scope="col">Для кого</th>
                <th scope="col">Последний запуск</th>
                <th scope="col">Работает</th>
                <th scope="col">
                  <span className="visually-hidden">Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const paused = pausedText(t.pausedReason);
                return (
                  <tr key={t.id}>
                    <td className={styles.taskName}>
                      {t.title}
                      {paused ? (
                        <div>
                          <Pill tone="warn">{paused}</Pill>
                        </div>
                      ) : null}
                    </td>
                    <td>{agentName(t.agentId)}</td>
                    <td>
                      <span className={styles.when}>
                        <Icon name={t.trigger === 'schedule' ? 'clock' : 'bolt'} size={15} />
                        {whenText(t)}
                      </span>
                    </td>
                    <td className={styles.who}>{whoText(t)}</td>
                    <td>
                      <button type="button" className={styles.last} onClick={() => setRunsOf(t)}>
                        {t.events ? eventsText(t.events) : lastFireText(t.lastFire)}
                      </button>
                    </td>
                    <td>
                      <Switch checked={t.status === 'active'} label={t.title} onChange={(on) => void toggle(t, on)} />
                    </td>
                    <td className={section.actionsCell}>
                      <TaskMenu task={t} onEdit={() => setEditing(t)} onRuns={() => setRunsOf(t)} onChanged={reload} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      <ApprovalTerms />
      <div className={`${styles.rules} rise`}>
        {RULES.map((r) => (
          <div key={r.name} className={styles.rule}>
            <Icon name="lock" className={styles.ruleIcon} />
            <div>
              <div className={styles.ruleName}>{r.name}</div>
              <div className={section.note}>{r.sub}</div>
            </div>
          </div>
        ))}
      </div>
      {editing ? (
        <TaskForm
          task={editing === 'new' ? null : editing}
          agents={agents}
          departments={departments}
          users={users}
          onClose={() => setEditing(null)}
          onSaved={(saved, stay) => {
            setEditing(stay ? saved : null);
            reload();
          }}
        />
      ) : null}
      {runsOf && runsOf.trigger !== 'schedule' ? <TaskEvents task={runsOf} onClose={() => setRunsOf(null)} /> : null}
      {runsOf && runsOf.trigger === 'schedule' ? <TaskRuns task={runsOf} onClose={() => setRunsOf(null)} /> : null}
    </div>
  );
}
