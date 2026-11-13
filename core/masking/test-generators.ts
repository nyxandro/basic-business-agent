// fast-check generators of valid personal-data values (shared test doubles for core/masking).
import fc from 'fast-check';
import type { MaskingKind } from '../config/schemas.ts';

const digitsOf = (n: number) => fc.array(fc.integer({ min: 0, max: 9 }), { minLength: n, maxLength: n });

function snilsControl(d: number[]): string {
  const sum = d.reduce((acc, x, i) => acc + x * (9 - i), 0);
  const c = sum < 100 ? sum : sum === 100 || sum === 101 ? 0 : sum % 101 === 100 ? 0 : sum % 101;
  return String(c).padStart(2, '0');
}

function innDigit(d: number[], weights: number[]): number {
  return (weights.reduce((acc, w, i) => acc + w * d[i]!, 0) % 11) % 10;
}

function luhnDigit(d: number[]): number {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let x = d[d.length - 1 - i]!;
    if (i % 2 === 0) {
      x *= 2;
      if (x > 9) x -= 9;
    }
    sum += x;
  }
  return (10 - (sum % 10)) % 10;
}

export const passportArb = digitsOf(10).map((d) => `${d.slice(0, 4).join('')} ${d.slice(4).join('')}`);
export const snilsArb = digitsOf(9).map((d) => {
  const s = d.join('');
  return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)} ${snilsControl(d)}`;
});
export const innArb = digitsOf(10).map((d) => {
  const d11 = [...d, innDigit(d, [7, 2, 4, 10, 3, 5, 9, 4, 6, 8])];
  return [...d11, innDigit(d11, [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8])].join('');
});
export const cardArb = fc.tuple(fc.integer({ min: 2, max: 6 }), digitsOf(14)).map(([first, rest]) => {
  const d = [first, ...rest];
  const all = [...d, luhnDigit(d)].join('');
  return all.match(/.{4}/g)!.join(' ');
});
export const phoneArb = digitsOf(9).map((d) => `+7 (9${d[0]}${d[1]}) ${d.slice(2, 5).join('')}-${d.slice(5, 7).join('')}-${d.slice(7).join('')}`);
export const emailArb = fc
  .tuple(fc.stringMatching(/^[a-z][a-z0-9.]{0,10}[a-z0-9]$/), fc.stringMatching(/^[a-z]{2,8}$/), fc.constantFrom('ru', 'com', 'org'))
  .filter(([local]) => !local.includes('..'))
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`);

export const VALUE_ARBS: Record<MaskingKind, fc.Arbitrary<string>> = {
  passport: passportArb,
  snils: snilsArb,
  inn: innArb,
  card: cardArb,
  phone: phoneArb,
  email: emailArb,
};
