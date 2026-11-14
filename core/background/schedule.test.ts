import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TaskSchedule } from '@bba/contracts';
import { cronOf, fireTimeOf, scheduleOf } from './schedule.ts';

describe('schedules of background tasks', () => {
  it('builds the cron of each preset, in the installation time zone', () => {
    expect(cronOf({ kind: 'weekdays', time: '09:00' })).toBe('0 9 * * 1-5');
    expect(cronOf({ kind: 'daily', time: '18:30' })).toBe('30 18 * * *');
    expect(cronOf({ kind: 'weekly', time: '08:05', weekday: 7 })).toBe('5 8 * * 0');
    expect(cronOf({ kind: 'monthly', time: '10:00', monthDay: 1 })).toBe('0 10 1 * *');
    // «по будням в 9:00» in Moscow: a Monday fire at 06:00 UTC.
    expect(fireTimeOf('0 9 * * 1-5', 'Europe/Moscow', new Date('2026-11-16T06:00:30Z')).toISOString()).toBe('2026-11-16T06:00:00.000Z');
  });

  it('reads a preset back from its cron and leaves any other cron as it is', () => {
    expect(scheduleOf('0 9 * * 1-5')).toEqual({ kind: 'weekdays', time: '09:00' });
    expect(scheduleOf('*/15 * * * *')).toBeNull();
    expect(scheduleOf('0 9 31 * *')).toBeNull();
    expect(scheduleOf('0 9 * 1 *')).toBeNull();
  });

  it('refuses a time that is not hh:mm', () => {
    expect(() => cronOf({ kind: 'daily', time: '9:00' })).toThrow(expect.objectContaining({ code: 'APP_VALIDATION_FAILED' }));
    expect(() => cronOf({ kind: 'daily', time: '24:00' })).toThrow(expect.objectContaining({ code: 'APP_VALIDATION_FAILED' }));
  });

  it('turns every preset into a cron and back into the same preset', () => {
    const time = fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 })).map(([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    const preset: fc.Arbitrary<TaskSchedule> = fc.oneof(
      time.map((t) => ({ kind: 'daily' as const, time: t })),
      time.map((t) => ({ kind: 'weekdays' as const, time: t })),
      fc.tuple(time, fc.integer({ min: 1, max: 7 })).map(([t, weekday]) => ({ kind: 'weekly' as const, time: t, weekday })),
      fc.tuple(time, fc.integer({ min: 1, max: 28 })).map(([t, monthDay]) => ({ kind: 'monthly' as const, time: t, monthDay })),
    );
    fc.assert(
      fc.property(preset, (s) => {
        expect(scheduleOf(cronOf(s))).toEqual(s);
      }),
    );
  });
});
