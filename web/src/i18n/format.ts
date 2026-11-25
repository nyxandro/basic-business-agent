// Numbers and dates as the Russian interface writes them.
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const MS_PER_DAY = 24 * MINUTES_PER_HOUR * MS_PER_MINUTE;
const THOUSAND = 1000;

export const rub = (value: number): string => `${Math.round(value).toLocaleString('ru-RU')} ₽`;

// «120 тыс.» for token counts.
export const thousands = (value: number): string => (value >= THOUSAND ? `${Math.round(value / THOUSAND).toLocaleString('ru-RU')} тыс.` : value.toLocaleString('ru-RU'));

const MILLION = 1_000_000;

// «52 тыс.», «1,05 млн» — for counts that reach millions (the size of the context of a model). What rounds to a
// thousand thousands is a million already.
export const largeCount = (value: number): string =>
  Math.round(value / THOUSAND) >= THOUSAND ? `${(value / MILLION).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} млн` : thousands(value);

// «1 декабря» from a date like 2026-12-01 (a calendar day, no time zone shift).
export function dayMonth(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) throw new Error(`expected a date like 2026-12-01, got "${isoDate}"`);
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return day.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

// «14 ноября, 09:00» in the browser's time zone.
// «16 декабря 2026»: a day that is not near.
export const fullDate = (iso: string): string => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '');
export const dateTime = (iso: string): string => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

// «сегодня», «вчера» or «2 ноября» (with the year when it is not this one), in the browser's zone.
export function dayLabel(iso: string, now: Date = new Date()): string {
  const day = new Date(iso);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(day)) / MS_PER_DAY);
  if (days === 0) return 'сегодня';
  if (days === 1) return 'вчера';
  return day.toLocaleDateString('ru-RU', day.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
}

// «сегодня в 9:00», «вчера в 18:40», «2 ноября в 10:14».
export const whenLabel = (iso: string, now: Date = new Date()): string => `${dayLabel(iso, now)} в ${new Date(iso).toLocaleTimeString('ru-RU', { hour: 'numeric', minute: '2-digit' })}`;

// «3 ч 5 мин» until a moment; «меньше минуты» when it is close or past.
export function timeLeft(iso: string, now: number = Date.now()): string {
  const minutes = Math.floor((new Date(iso).getTime() - now) / MS_PER_MINUTE);
  if (minutes < 1) return 'меньше минуты';
  const h = Math.floor(minutes / MINUTES_PER_HOUR);
  const m = minutes % MINUTES_PER_HOUR;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

const PLURAL = new Intl.PluralRules('ru-RU');

// The form of a word after a number: plural(5, ['действие', 'действия', 'действий']) → «действий».
export function plural(n: number, forms: [one: string, few: string, many: string]): string {
  const rule = PLURAL.select(n);
  return rule === 'one' ? forms[0] : rule === 'few' ? forms[1] : forms[2];
}

// «ноябрь» — the month of a date, as a calendar names it.
export const monthName = (date: Date): string => new Intl.DateTimeFormat('ru-RU', { month: 'long' }).format(date);

const KB = 1024;
// «2,4 МБ», «830 КБ», «120 Б».
export function fileSize(bytes: number): string {
  if (bytes < KB) return `${bytes} Б`;
  if (bytes < KB * KB) return `${Math.round(bytes / KB)} КБ`;
  return `${(bytes / KB / KB).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;
}
