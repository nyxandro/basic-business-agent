import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { visibleText } from './visible-text.ts';

// Words that are never Markdown on their own: letters and digits only.
const word = fc.string({ unit: fc.constantFrom(...'абвгдежзиклмнопрстуфхцчшщыэюяАБВЖЗМПСТabcxyzXYZ0123456789'), minLength: 1, maxLength: 8 });
const words = fc.array(word, { minLength: 1, maxLength: 12 });
// What ends a line: a line break or a blank line. Words of one line are split by spaces; a space
// between lines would put a line's mark («- », «# ») mid-line, where it is plain text.
const gap = fc.constantFrom('\n', '\n\n');

// Inline marks around one word: the chat shows the word alone.
const INLINE: ((w: string) => string)[] = [(w) => w, (w) => `**${w}**`, (w) => `*${w}*`, (w) => `_${w}_`, (w) => `\`${w}\``, (w) => `~~${w}~~`, (w) => `[${w}](https://example.com/x)`];
// Marks of a whole line: a heading, list items, a quote.
const LINE: ((line: string) => string)[] = [(l) => l, (l) => `# ${l}`, (l) => `### ${l}`, (l) => `- ${l}`, (l) => `1. ${l}`, (l) => `> ${l}`];

describe('visible text of an agent’s answer', () => {
  it('drops the marks of the screenshot of 16.11 and keeps the words', () => {
    expect(visibleText('Вот что я реально умею. **Из инструментов:**\n1. **Заметки** — вести персональные заметки с поиском')).toBe('Вот что я реально умею. Из инструментов: Заметки — вести персональные заметки с поиском');
  });

  it('shows tables, links, pictures and code by their text, without pipes, brackets and fences', () => {
    const md = ['## Итог', '', '| Товар | Цена |', '|---|---:|', '| Бетон | 5 000 ₽ |', '', 'См. [договор](https://example.com/d.pdf) и ![схема склада](s.png).', '', '```js', 'const a = 1;', '```', '', '- [x] сделано', '---', 'Сноска[^1].', '', '[^1]: Из письма.'].join('\n');
    expect(visibleText(md)).toBe('Итог Товар Цена Бетон 5 000 ₽ См. договор и схема склада. const a = 1; сделано Сноска. Из письма.');
  });

  it('keeps characters that only look like marks: escapes, a lone star, snake_case', () => {
    expect(visibleText('2 \\* 3 = 6, цена *за м², файл report_2026_final.xlsx')).toBe('2 * 3 = 6, цена *за м², файл report_2026_final.xlsx');
  });

  it('is empty for an empty answer and for an answer of marks alone', () => {
    expect(visibleText('')).toBe('');
    expect(visibleText('---\n\n***')).toBe('');
  });

  // No counterexample in the default 100 runs over answers of plain words in marked lines.
  it('the marks of words and lines never reach the visible text, the words always do', () => {
    const line = fc.tuple(words, fc.constantFrom(...LINE)).chain(([ws, lineMark]) =>
      fc.array(fc.constantFrom(...INLINE), { minLength: ws.length, maxLength: ws.length }).map((marks) => ({ ws, text: lineMark(ws.map((w, i) => marks[i]!(w)).join(' ')) })),
    );
    fc.assert(
      fc.property(fc.array(fc.tuple(line, gap), { minLength: 1, maxLength: 6 }), (lines) => {
        const markdown = lines.map(([l, g]) => l.text + g).join('');
        const plain = lines.flatMap(([l]) => l.ws).join(' ');
        expect(visibleText(markdown)).toBe(plain);
      }),
      { examples: [[[[{ ws: ['Заметки'], text: '1. **Заметки**' }, '\n']]]] },
    );
  });
});
