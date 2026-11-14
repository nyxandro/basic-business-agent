// Period fields of reports: dates as YYYY-MM-DD in the browser's calendar.
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const today = (): string => iso(new Date());
export const monthStart = (): string => {
  const d = new Date();
  return iso(new Date(d.getFullYear(), d.getMonth(), 1));
};
