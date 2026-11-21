// Quiet hours (docs/specs/[20.11.2026]-notifications.md, section 5): from 21:00 to 8:00 by the time zone of the
// installation a push waits for the morning; the list shows everything at once.
export const QUIET_FROM_HOUR = 21;
export const QUIET_TO_HOUR = 8;

interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
}

function localTime(at: Date, timezone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour') };
}

// The zone's offset from UTC at a moment, in minutes.
function offsetMinutes(at: Date, timezone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')!.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

// 8:00 of a local day as a moment: the offset is taken at that very hour (a change of clocks at night is respected).
function localMorning(year: number, month: number, day: number, timezone: string): Date {
  const guess = Date.UTC(year, month - 1, day, QUIET_TO_HOUR, 0, 0);
  const first = guess - offsetMinutes(new Date(guess), timezone) * 60_000;
  return new Date(guess - offsetMinutes(new Date(first), timezone) * 60_000);
}

// When a push may go: null — now; otherwise the next 8:00 of the installation.
export function quietUntil(now: Date, timezone: string): Date | null {
  const local = localTime(now, timezone);
  if (local.hour >= QUIET_TO_HOUR && local.hour < QUIET_FROM_HOUR) return null;
  if (local.hour < QUIET_TO_HOUR) return localMorning(local.year, local.month, local.day, timezone);
  // Evening: the morning of the next local day (Date.UTC carries the day over the end of a month).
  const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  return localMorning(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timezone);
}
