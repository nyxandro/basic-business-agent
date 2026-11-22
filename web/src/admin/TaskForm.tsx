// A background task (spec, scenario 4): its name, the agent, how it starts — by a schedule as a preset in the
// installation's time, on a letter in an employee's mailbox or on a message of another system
// (docs/specs/[20.11.2026]-event-tasks.md) — the area or the executor, and what the agent is asked to do. The kind of
// start is chosen once: a saved task keeps it.
import type { AdminAgent, AdminDepartment, AdminTask, AdminPerson, TaskAccess, TaskSchedule, TaskTrigger } from '@bba/contracts';
import { useState } from 'react';
import { Button, cx } from '../ui/Button.tsx';
import { Field, Input, Select, TextArea } from '../ui/Field.tsx';
import { Modal } from '../ui/Modal.tsx';
import { AccessPicker, accessIsEmpty } from './AccessPicker.tsx';
import { adminApi } from './api.ts';
import models from './models.module.css';
import { Feedback, useAction } from './parts.tsx';
import section from './section.module.css';
import { ExecutorField, HookAddress, MailFilterFields, MailReach } from './TaskEventFields.tsx';
import { listOf, scheduleText, WEEKDAYS } from './tasks-text.ts';

type Kind = TaskSchedule['kind'];
const KINDS: { value: Kind; label: string }[] = [
  { value: 'daily', label: 'Каждый день' },
  { value: 'weekdays', label: 'По будням' },
  { value: 'weekly', label: 'Раз в неделю' },
  { value: 'monthly', label: 'Раз в месяц' },
];
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);
const STARTS: { value: 'schedule' | 'event'; label: string }[] = [
  { value: 'schedule', label: 'По расписанию' },
  { value: 'event', label: 'По событию' },
];
const SOURCES: { value: Exclude<TaskTrigger, 'schedule'>; label: string }[] = [
  { value: 'mail', label: 'Письмо в почте сотрудника' },
  { value: 'webhook', label: 'Сообщение от другой системы' },
];
const DEFAULT_TIME = '09:00';

function scheduleOf(kind: Kind, time: string, weekday: number, monthDay: number): TaskSchedule {
  if (kind === 'weekly') return { kind, time, weekday };
  if (kind === 'monthly') return { kind, time, monthDay };
  return { kind, time };
}

function TaskFormBody({ task, agents, departments, users, onClose, onSaved }: { task: AdminTask | null; agents: AdminAgent[]; departments: AdminDepartment[]; users: AdminPerson[]; onClose: () => void; onSaved: (saved: AdminTask, stay: boolean) => void }) {
  const s = task?.schedule ?? null;
  const [trigger, setTrigger] = useState<TaskTrigger>(task?.trigger ?? 'schedule');
  const [from, setFrom] = useState(task?.mailFilter?.from.join(', ') ?? '');
  const [subject, setSubject] = useState(task?.mailFilter?.subject.join(', ') ?? '');
  const [executorId, setExecutorId] = useState(task?.executor?.id ?? '');
  const [title, setTitle] = useState(task?.title ?? '');
  const [agentId, setAgentId] = useState(task?.agentId ?? agents[0]?.id ?? '');
  const [access, setAccess] = useState<TaskAccess>(task?.access ?? { scope: 'org', departmentIds: [], userIds: [] });
  const [kind, setKind] = useState<Kind>(s?.kind ?? 'weekdays');
  // A task of stage 1 keeps its own cron until the admin touches the schedule.
  const [scheduleTouched, setScheduleTouched] = useState(task === null || s !== null);
  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    setScheduleTouched(true);
    set(v);
  };
  const [time, setTime] = useState(s?.time ?? DEFAULT_TIME);
  const [weekday, setWeekday] = useState(s?.kind === 'weekly' ? s.weekday : 1);
  const [monthDay, setMonthDay] = useState(s?.kind === 'monthly' ? s.monthDay : 1);
  const [prompt, setPrompt] = useState(task?.prompt ?? '');
  const { busy, error, run } = useAction();

  async function save() {
    const schedule = scheduleOf(kind, time, weekday, monthDay);
    const mailFilter = { from: listOf(from), subject: listOf(subject) };
    const base = { title: title.trim(), agentId, prompt: prompt.trim() };
    let saved: AdminTask | null = null;
    const ok = task
      ? await run(async () => {
          const change = trigger === 'schedule' ? { ...base, access, ...(scheduleTouched ? { schedule } : {}) } : trigger === 'mail' ? { ...base, access, mailFilter } : { ...base, executorId };
          saved = await adminApi.updateTask(task.id, change);
        })
      : await run(async () => {
          const input = trigger === 'schedule' ? { ...base, trigger, access, schedule } : trigger === 'mail' ? { ...base, trigger, access, mailFilter } : { ...base, trigger, executorId };
          saved = await adminApi.createTask(input);
        }, 'Задача создана');
    // A new webhook task stays open: its address is what the admin needs next.
    if (ok && saved) onSaved(saved, task === null && trigger === 'webhook');
  }
  const start = trigger === 'schedule' ? 'schedule' : 'event';

  return (
    <form
      className={section.form}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className={section.formTitle}>{task ? task.title : 'Новая задача'}</h2>
      <Feedback error={error} />
      <div className={section.row}>
        <Field label="Название">
          <Input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Утренняя сводка руководителю" />
        </Field>
        <Field label="Агент">
          <Select required value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset className={models.prices}>
        <legend className={models.legend}>Когда запускать</legend>
        {task ? <p className={section.note}>Вид запуска у созданной задачи не меняется.</p> : null}
        <div role="group" aria-label="Когда запускать" className={models.chips}>
          {STARTS.map((k) => (
            <button key={k.value} type="button" disabled={task !== null} aria-pressed={start === k.value} className={cx(models.chip, start === k.value && models.chipOn)} onClick={() => setTrigger(k.value === 'schedule' ? 'schedule' : 'mail')}>
              {k.label}
            </button>
          ))}
        </div>
        {start === 'event' ? (
          <div role="group" aria-label="Источник события" className={models.chips}>
            {SOURCES.map((k) => (
              <button key={k.value} type="button" disabled={task !== null} aria-pressed={trigger === k.value} className={cx(models.chip, trigger === k.value && models.chipOn)} onClick={() => setTrigger(k.value)}>
                {k.label}
              </button>
            ))}
          </div>
        ) : null}
      </fieldset>
      {trigger === 'webhook' ? (
        <>
          <ExecutorField value={executorId} users={users} onChange={setExecutorId} />
          {task ? <HookAddress task={task} onRenewed={(renewed) => onSaved(renewed, true)} /> : <p className={section.note}>Адрес для другой системы появится после сохранения. Интернета в запусках по событию у агента нет.</p>}
        </>
      ) : (
        <>
          <AccessPicker legend="Область" value={access} onChange={setAccess} departments={departments} users={users} />
          <p className={section.note}>
            {trigger === 'mail'
              ? 'Задача разбирает новые письма каждого сотрудника области, у кого подключена почта, — его доступом; ответ уходит только после его «Да». Письма, пришедшие до включения и старше суток, не трогаются; интернета в таких запусках нет.'
              : 'Задача выполняется у каждого сотрудника области от его имени, с его доступами и лимитами; каждое действие наружу ждёт его «Да».'}
          </p>
          {trigger === 'mail' ? (
            <>
              <MailFilterFields from={from} subject={subject} onFrom={setFrom} onSubject={setSubject} />
              <MailReach agentId={agentId} access={access} />
            </>
          ) : null}
        </>
      )}
      {trigger === 'schedule' ? (
      <fieldset className={models.prices}>
        <legend className={models.legend}>Расписание</legend>
        {!scheduleTouched && task ? <p className={section.note}>Сейчас: {scheduleText(null, task.cron)}. Выберите вариант ниже, чтобы заменить его.</p> : null}
        <div role="group" aria-label="Расписание" className={models.chips}>
          {KINDS.map((k) => (
            <button key={k.value} type="button" aria-pressed={scheduleTouched && kind === k.value} className={cx(models.chip, scheduleTouched && kind === k.value && models.chipOn)} onClick={() => touch(setKind)(k.value)}>
              {k.label}
            </button>
          ))}
        </div>
        <div className={cx(section.row, models.pickList)}>
          {kind === 'weekly' ? (
            <Field label="День недели">
              <Select value={weekday} onChange={(e) => touch(setWeekday)(Number(e.target.value))}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i + 1}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {kind === 'monthly' ? (
            <Field label="Число месяца">
              <Select value={monthDay} onChange={(e) => touch(setMonthDay)(Number(e.target.value))}>
                {MONTH_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Время" hint="По часам установки.">
            <Input type="time" required value={time} onChange={(e) => touch(setTime)(e.target.value)} />
          </Field>
        </div>
      </fieldset>
      ) : null}
      <Field label="Что сделать агенту">
        <TextArea required rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={trigger === 'schedule' ? 'Собери сделки без движения за неделю и пришли сводку руководителю отдела.' : trigger === 'mail' ? 'Разбери письмо: если это заказ — найди клиента в Битрикс24 и подготовь ответ с ценой и сроком; ответ отправь только после «Да».' : 'Найди сделку по номеру из события, оцени, насколько она горячая, и поставь ответственному задачу позвонить сегодня.'} />
      </Field>
      <div className={section.formActions}>
        <Button onClick={onClose}>Отмена</Button>
        <Button type="submit" variant="primary" disabled={busy || !title.trim() || !prompt.trim() || !agentId || (trigger === 'webhook' ? !executorId : accessIsEmpty(access))}>
          {task ? 'Сохранить' : 'Создать задачу'}
        </Button>
      </div>
    </form>
  );
}

// `onSaved` gets the saved task and whether the form stays open on it (a new webhook task shows its address).
export function TaskForm(props: { task: AdminTask | null; agents: AdminAgent[]; departments: AdminDepartment[]; users: AdminPerson[]; onClose: () => void; onSaved: (saved: AdminTask, stay: boolean) => void }) {
  return (
    <Modal open onClose={props.onClose} label={props.task ? props.task.title : 'Новая задача'}>
      <TaskFormBody {...props} />
    </Modal>
  );
}
