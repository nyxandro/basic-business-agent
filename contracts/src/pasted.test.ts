// A long text pasted into the input (request of the owner 25.11): a part of the message the model reads as it is, between
// two lines of its own; the chat folds it in the input and in the bubble. Writing and reading back must agree.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PASTED_END, PASTED_START, splitPasted, withPasted } from './pasted.ts';

describe('a pasted text in a message', () => {
  it('stands after the words between its two lines, and is read back apart from them', () => {
    const message = withPasted('Что тут не так?', ['Пункт 1. Оплата.\nПункт 2. Срок.']);
    expect(message).toBe(`Что тут не так?\n\n${PASTED_START}\nПункт 1. Оплата.\nПункт 2. Срок.\n${PASTED_END}`);
    expect(splitPasted(message)).toEqual({ text: 'Что тут не так?', pieces: ['Пункт 1. Оплата.\nПункт 2. Срок.'] });
  });

  it('a message of pasted texts alone, several of them; a message without one is as it is', () => {
    expect(splitPasted(withPasted('', ['первый', 'второй']))).toEqual({ text: '', pieces: ['первый', 'второй'] });
    expect(withPasted('Привет', [])).toBe('Привет');
    expect(splitPasted('Привет\n\nкак дела')).toEqual({ text: 'Привет\n\nкак дела', pieces: [] });
  });

  // The person's own words that merely name the line are not a pasted text: it must stand on lines of its own.
  it('is not found in words that only mention its line', () => {
    expect(splitPasted(`Напиши ${PASTED_START} в начале`)).toEqual({ text: `Напиши ${PASTED_START} в начале`, pieces: [] });
  });

  // Contract: a pasted text that holds the closing line itself on a line of its own is cut there — a person does not paste
  // our own service line; the generator below leaves it out.
  it('writes and reads back any words and pasted texts the same', () => {
    const noServiceLine = (s: string) => !s.split('\n').some((line) => line === PASTED_START || line === PASTED_END);
    const words = fc.string({ unit: 'grapheme', maxLength: 200 }).filter(noServiceLine);
    const piece = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 400 }).filter(noServiceLine);
    fc.assert(
      fc.property(words, fc.array(piece, { maxLength: 3 }), (text, pieces) => {
        expect(splitPasted(withPasted(text, pieces))).toEqual({ text, pieces });
      }),
      {
        examples: [
          ['', ['одна вставка']],
          ['слова\n', ['вставка с переводом строки в конце\n']],
          ['', [`\n${PASTED_START}\nвнутри`]],
          ['  ', ['\n\n']],
        ],
      },
    );
  });
});
