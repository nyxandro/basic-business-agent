import { describe, expect, it } from 'vitest';
import { MASKING_KINDS, type MaskingKind } from '../config/schemas.ts';
import { detect, validInn, validLuhn, validSnils } from './detect.ts';

const ALL = new Set<MaskingKind>(MASKING_KINDS);
const kindsIn = (text: string, kinds: ReadonlySet<MaskingKind> = ALL) => detect(text, kinds).map((d) => [d.kind, d.value]);

describe('checksums', () => {
  it('accepts valid and rejects altered numbers', () => {
    expect(validSnils('112-233-445 95')).toBe(true);
    expect(validSnils('112-233-445 96')).toBe(false);
    expect(validInn('7707083893')).toBe(true); // a legal entity
    expect(validInn('7707083894')).toBe(false);
    expect(validInn('500100732259')).toBe(true); // a person
    expect(validInn('500100732250')).toBe(false);
    expect(validLuhn('4111 1111 1111 1111')).toBe(true);
    expect(validLuhn('4111 1111 1111 1112')).toBe(false);
  });
});

describe('detect', () => {
  it('finds every kind in Russian business text', () => {
    const text =
      'Иванов, паспорт 4510 123456, СНИЛС 112-233-445 95, ИНН 500100732259, карта 4111 1111 1111 1111, ' +
      'тел. +7 (912) 345-67-89, почта ivan.petrov@example.ru';
    expect(kindsIn(text)).toEqual([
      ['passport', '4510 123456'],
      ['snils', '112-233-445 95'],
      ['inn', '500100732259'],
      ['card', '4111 1111 1111 1111'],
      ['phone', '+7 (912) 345-67-89'],
      ['email', 'ivan.petrov@example.ru'],
    ]);
  });

  it('leaves contract numbers, amounts and dates alone', () => {
    expect(kindsIn('Договор № 12345678901 от 01.02.2026 на сумму 1 200 000 ₽, счёт 4111111111111112')).toEqual([]);
  });

  it('looks only for the kinds the admin switched on', () => {
    expect(kindsIn('ivan@example.ru, +7 912 345 67 89', new Set<MaskingKind>(['phone']))).toEqual([['phone', '+7 912 345 67 89']]);
  });

  it('accepts phone formats with 8 and without separators', () => {
    expect(kindsIn('8 (912) 345-67-89 и 89123456789')).toEqual([
      ['phone', '8 (912) 345-67-89'],
      ['phone', '89123456789'],
    ]);
  });
});
