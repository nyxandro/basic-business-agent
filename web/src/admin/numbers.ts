// Number fields of the admin panel: an empty field means "no value" (no limit, or the default).
export const toField = (value: number | null): string => (value === null ? '' : String(value));

export function fromField(text: string, kind: 'rub' | 'tokens'): number | null | 'invalid' {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return 'invalid';
  if (kind === 'tokens' && (!Number.isInteger(n) || n === 0)) return 'invalid';
  return n;
}
