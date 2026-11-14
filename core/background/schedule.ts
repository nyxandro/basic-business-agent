// Schedules of background tasks (spec, section 8.6): the admin picks a preset and a time in the
// installation's time zone; the code builds the cron. A cron that is no preset (a stage 1 task)
// is shown as it is and can only be replaced by a preset.
import type { TaskSchedule } from '@bba/contracts';
import { Cron } from 'croner';
import { appError } from '../errors/catalog.ts';

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
// Days of the month every month has: a monthly task never skips a month.
export const MONTH_DAY_MAX = 28;

function clock(time: string): { hour: number; minute: number } {
  const match = TIME.exec(time);
  if (!match) throw appError('APP_VALIDATION_FAILED', `bad time "${time}"`, { userMessage: 'Время — в виде чч:мм, например 09:00.' });
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function cronOf(schedule: TaskSchedule): string {
  const { hour, minute } = clock(schedule.time);
  switch (schedule.kind) {
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'weekly':
      // 1 — Monday … 7 — Sunday, as people count; cron counts Sunday as 0.
      return `${minute} ${hour} * * ${schedule.weekday % 7}`;
    case 'monthly':
      return `${minute} ${hour} ${schedule.monthDay} * *`;
  }
}

const two = (n: number) => String(n).padStart(2, '0');

// The preset of a cron, or null for any other cron.
export function scheduleOf(cron: string): TaskSchedule | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5 || !parts.slice(0, 2).every((p) => /^\d{1,2}$/.test(p))) return null;
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  if (Number(minute) > 59 || Number(hour) > 23 || month !== '*') return null;
  const time = `${two(Number(hour))}:${two(Number(minute))}`;
  if (day === '*' && weekday === '*') return { kind: 'daily', time };
  if (day === '*' && weekday === '1-5') return { kind: 'weekdays', time };
  if (day === '*' && /^[0-7]$/.test(weekday)) return { kind: 'weekly', time, weekday: Number(weekday) === 0 ? 7 : Number(weekday) };
  if (weekday === '*' && /^\d{1,2}$/.test(day) && Number(day) >= 1 && Number(day) <= MONTH_DAY_MAX) return { kind: 'monthly', time, monthDay: Number(day) };
  return null;
}

// The time the schedule named for a fire happening now: the same fire is counted once.
export function fireTimeOf(cron: string, timezone: string, now: Date): Date {
  const previous = new Cron(cron, { timezone, paused: true }).previousRuns(1, new Date(now.getTime() + 1000))[0];
  if (!previous) throw new Error(`cron "${cron}" has no fire before ${now.toISOString()}`);
  return previous;
}

export function assertCron(cron: string, timezone: string): void {
  try {
    new Cron(cron, { timezone, paused: true });
  } catch (error) {
    throw appError('APP_VALIDATION_FAILED', `bad cron "${cron}"`, { cause: error });
  }
}
