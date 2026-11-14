// Words of «Режимы работы» (spec, section 13): the schedule, the last fire and a person's run.
import type { RunOutcomeName, TaskFireSummary, TaskRunDto, TaskSchedule } from '@bba/contracts';
import { plural } from '../ui/format.ts';

export const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const WEEKDAYS_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

export function scheduleText(schedule: TaskSchedule | null, cron: string): string {
  if (!schedule) return `по расписанию ${cron}`;
  switch (schedule.kind) {
    case 'daily':
      return `Каждый день в ${schedule.time}`;
    case 'weekdays':
      return `По будням в ${schedule.time}`;
    case 'weekly':
      return `Раз в неделю: ${WEEKDAYS_SHORT[schedule.weekday - 1]} в ${schedule.time}`;
    case 'monthly':
      return `Раз в месяц: ${schedule.monthDay} числа в ${schedule.time}`;
  }
}

// «Выполнено у 7 из 8» after a fire, «Идёт: 3 из 8» while people's runs are still going.
export function lastFireText(fire: TaskFireSummary | null): string {
  if (!fire) return 'не запускалась';
  const going = fire.counts.queued + fire.counts.running;
  if (going > 0) return `Идёт: ${fire.total - going} из ${fire.total}`;
  return `Выполнено у ${fire.counts.done} из ${fire.total}`;
}

export function pausedText(reason: string | null): string | null {
  if (reason === 'agent_missing') return 'Агента больше нет';
  if (reason === 'scope_empty') return 'Некому выполнять';
  return null;
}

const OUTCOMES: Record<RunOutcomeName, string> = {
  queued: 'В очереди',
  running: 'Идёт',
  done: 'Выполнено',
  'awaiting-approval': 'Ждёт решения',
  failed: 'Ошибка',
  skipped: 'Пропущено',
};

const SKIP_REASONS: Record<string, string> = {
  no_access: 'нет доступа к агенту',
  blocked: 'сотрудник заблокирован',
  awaiting_approval: 'ещё ждёт решения по прошлому запуску',
  too_late: 'опоздал больше чем на сутки',
};

export function runText(run: TaskRunDto): string {
  const base = OUTCOMES[run.outcome];
  if (run.outcome === 'skipped' && run.reasonCode) return `${base}: ${SKIP_REASONS[run.reasonCode] ?? run.reasonCode}`;
  if (run.outcome === 'failed' && run.reasonCode) return `${base} · ${run.reasonCode}`;
  return base;
}

export const tasksCount = (n: number) => `${n} ${plural(n, ['задача', 'задачи', 'задач'])}`;
