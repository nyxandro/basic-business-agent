// Finds personal data in text (spec, section 8.11). Numbers with a checksum (SNILS, INN, card)
// are taken only when the checksum is right, so contract or invoice numbers are left alone.
import type { MaskingKind } from '../config/schemas.ts';

export interface Detection {
  kind: MaskingKind;
  start: number;
  end: number;
  value: string;
}

export const PLACEHOLDER_NAMES: Record<MaskingKind, string> = {
  passport: 'ПАСПОРТ',
  snils: 'СНИЛС',
  card: 'КАРТА',
  inn: 'ИНН',
  phone: 'ТЕЛЕФОН',
  email: 'ПОЧТА',
};

const digits = (s: string): number[] => s.replace(/\D/g, '').split('').map(Number);

export function validSnils(value: string): boolean {
  const d = digits(value);
  if (d.length !== 11) return false;
  const sum = d.slice(0, 9).reduce((acc, x, i) => acc + x * (9 - i), 0);
  const control = sum < 100 ? sum : sum === 100 || sum === 101 ? 0 : sum % 101 === 100 ? 0 : sum % 101;
  return control === d[9]! * 10 + d[10]!;
}

function innDigit(d: number[], weights: number[]): number {
  return (weights.reduce((acc, w, i) => acc + w * d[i]!, 0) % 11) % 10;
}

export function validInn(value: string): boolean {
  const d = digits(value);
  if (d.length === 10) return innDigit(d, [2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  if (d.length === 12) {
    return innDigit(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && innDigit(d, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
  }
  return false;
}

export function validLuhn(value: string): boolean {
  const d = digits(value);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let x = d[d.length - 1 - i]!;
    if (i % 2 === 1) {
      x *= 2;
      if (x > 9) x -= 9;
    }
    sum += x;
  }
  return sum % 10 === 0;
}

interface Rule {
  kind: MaskingKind;
  pattern: RegExp;
  valid?: (value: string) => boolean;
}

// Order is priority: an earlier rule wins where two matches overlap.
const RULES: Rule[] = [
  { kind: 'email', pattern: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu },
  { kind: 'card', pattern: /(?<!\d)\d{4}(?:[ -]?\d{4}){2}(?:[ -]?\d{1,7})(?!\d)/g, valid: validLuhn },
  { kind: 'snils', pattern: /(?<!\d)\d{3}[- ]?\d{3}[- ]?\d{3}[- ]?\d{2}(?!\d)/g, valid: validSnils },
  { kind: 'passport', pattern: /(?<!\d)\d{2} ?\d{2} \d{6}(?!\d)/g },
  { kind: 'inn', pattern: /(?<!\d)(?:\d{12}|\d{10})(?!\d)/g, valid: validInn },
  { kind: 'phone', pattern: /(?<![\d+])(?:\+7|8)[ -]?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{2}[ -]?\d{2}(?!\d)/g },
];

export function detect(text: string, kinds: ReadonlySet<MaskingKind>): Detection[] {
  const found: Detection[] = [];
  for (const rule of RULES) {
    if (!kinds.has(rule.kind)) continue;
    for (const m of text.matchAll(rule.pattern)) {
      const start = m.index;
      const end = start + m[0].length;
      if (rule.valid && !rule.valid(m[0])) continue;
      if (found.some((f) => start < f.end && end > f.start)) continue;
      found.push({ kind: rule.kind, start, end, value: m[0] });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}
