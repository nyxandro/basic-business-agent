// A background task (spec, scenario 4): its name, the agent, the area — the organisation,
// departments or employees, each runs it on their own behalf — the schedule as a preset in the
// installation's time and what the agent is asked to do.
import type { AdminAgent, AdminDepartment, AdminTask, AdminUser, TaskAccess, TaskSchedule } from '@bba/contracts';
import { useState } from 'react';
import { Button, cx } from '../ui/Button.tsx';
import { Field, Input, Select, TextArea } from '../ui/Field.tsx';
import { Modal } from '../ui/Modal.tsx';
import { AccessPicker, accessIsEmpty } from './AccessPicker.tsx';
import { adminApi } from './api.ts';
import models from './models.module.css';
import { Feedback, useAction } from './parts.tsx';
import section from './section.module.css';
import { WEEKDAYS } from './tasks-text.ts';

type Kind = TaskSchedule['kind'];
const KINDS: { value: Kind; label: string }[] = [
  { value: 'daily', label: 'Каждый день' },
  { value: 'weekdays', label: 'По будням' },
  { value: 'weekly', label: 'Раз в неделю' },
  { value: 'monthly', label: 'Раз в месяц' },
];
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);
const DEFAULT_TIME = '09:00';

function scheduleOf(kind: Kind, time: string, weekday: number, monthDay: number): TaskSchedule {
  if (kind === 'weekly') return { kind, time, weekday };
  if (kind === 'monthly') return { kind, time, monthDay };
  return { kind, time };
}

function TaskFormBody({ task, agents, departments, users, onClose, onSaved }: { task: AdminTask | null; agents: AdminAgent[]; departments: AdminDepartment[]; users: AdminUser[]; onClose: () => void; onSaved: () => void }) {
  const s = task?.schedule ?? null;
  const [title, setTitle] = useState(task?.title ?? '');
  const [agentId, setAgentId] = useState(task?.agentId ?? agents[0]?.id ?? '');
  const [access, setAccess] = useState<TaskAccess>(task?.access ?? { scope: 'org', departmentIds: [], userIds: [] });
  const [kind, setKind] = useState<Kind>(s?.kind ?? 'weekdays');
  const [time, setTime] = useState(s?.time ?? DEFAULT_TIME);
  const [weekday, setWeekday] = useState(s?.kind === 'weekly' ? s.weekday : 1);
  const [monthDay, setMonthDay] = useState(s?.kind === 'monthly' ? s.monthDay : 1);
  const [prompt, setPrompt] = useState(task?.prompt ?? '');
  const { busy, error, run } = useAction();

  async function save() {
    const input = { title: title.trim(), agentId, access, schedule: scheduleOf(kind, time, weekday, monthDay), prompt: prompt.trim() };
    const ok = task ? await run(() => adminApi.updateTask(task.id, input)) : await run(() => adminApi.createTask(input), 'Задача создана');
    if (ok) onSaved();
  }

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
      <AccessPicker legend="Область" value={access} onChange={setAccess} departments={departments} users={users} />
      <p className={section.note}>Задача выполняется у каждого сотрудника области от его имени, с его доступами и лимитами; каждое действие наружу ждёт его «Да».</p>
      <fieldset className={models.prices}>
        <legend className={models.legend}>Расписание</legend>
        <div role="group" aria-label="Расписание" className={models.chips}>
          {KINDS.map((k) => (
            <button key={k.value} type="button" aria-pressed={kind === k.value} className={cx(models.chip, kind === k.value && models.chipOn)} onClick={() => setKind(k.value)}>
              {k.label}
            </button>
          ))}
        </div>
        <div className={cx(section.row, models.pickList)}>
          {kind === 'weekly' ? (
            <Field label="День недели">
              <Select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
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
              <Select value={monthDay} onChange={(e) => setMonthDay(Number(e.target.value))}>
                {MONTH_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Время" hint="По часам установки.">
            <Input type="time" required value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
        </div>
      </fieldset>
      <Field label="Что сделать агенту">
        <TextArea required rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Собери сделки без движения за неделю и пришли сводку руководителю отдела." />
      </Field>
      <div className={section.formActions}>
        <Button onClick={onClose}>Отмена</Button>
        <Button type="submit" variant="primary" disabled={busy || !title.trim() || !prompt.trim() || !agentId || accessIsEmpty(access)}>
          {task ? 'Сохранить' : 'Создать задачу'}
        </Button>
      </div>
    </form>
  );
}

export function TaskForm(props: { task: AdminTask | null; agents: AdminAgent[]; departments: AdminDepartment[]; users: AdminUser[]; onClose: () => void; onSaved: () => void }) {
  return (
    <Modal open onClose={props.onClose} label={props.task ? props.task.title : 'Новая задача'}>
      <TaskFormBody {...props} />
    </Modal>
  );
}
