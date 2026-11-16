import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { visibleText } from './visible-text.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const packageJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };

// Words that are never Markdown on their own: letters and digits only.
const word = fc.string({ unit: fc.constantFrom(...'абвгдежзиклмнопрстуфхцчшщыэюяАБВЖЗМПСТabcxyzXYZ0123456789'), minLength: 1, maxLength: 8 });
const words = fc.array(word, { minLength: 1, maxLength: 12 });
// What ends a line: a line break or a blank line. Words of one line are split by spaces; a space
// between lines would put a line's mark («- », «# ») mid-line, where it is plain text.
const gap = fc.constantFrom('\n', '\n\n');

// Inline marks around one word: the chat shows the word alone.
const INLINE: ((w: string) => string)[] = [(w) => w, (w) => `**${w}**`, (w) => `__${w}__`, (w) => `*${w}*`, (w) => `_${w}_`, (w) => `\`${w}\``, (w) => `~~${w}~~`, (w) => `[${w}](https://example.com/x)`];
// Marks of a whole line: headings, list items, a quote.
const LINE: ((line: string) => string)[] = [(l) => l, (l) => `# ${l}`, (l) => `### ${l}`, (l) => `- ${l}`, (l) => `1. ${l}`, (l) => `> ${l}`];

describe('visible text of an agent’s answer', () => {
  it('reads Markdown with the chat’s own parser: the version the chat’s renderer depends on', () => {
    const ours = packageJson('.').dependencies?.['@copilotkit/markdown'];
    expect(ours).toBeDefined();
    expect(packageJson('web/node_modules/@copilotkit/react-core').dependencies?.['@copilotkit/markdown']).toBe(ours);
  });

  it('drops the marks of the screenshot of 16.11 and keeps the words', () => {
    expect(visibleText('Вот что я реально умею. **Из инструментов:**\n1. **Заметки** — вести персональные заметки с поиском')).toBe('Вот что я реально умею. Из инструментов: Заметки — вести персональные заметки с поиском');
  });

  it('shows tables, links, task lists, code and footnotes by what the chat draws of them', () => {
    const md = ['## Итог', '', '| Товар | Цена |', '|---|---:|', '| Бетон | 5 000 ₽ |', '', 'См. [договор](https://example.com/d.pdf), <https://example.com/s>, картинка ![схема](s.png).', '', '```js', 'const a = 1;', '```', '', '- [x] сделано', '', 'Сноска[^1].', '', '[^1]: https://example.com/letter'].join('\n');
    expect(visibleText(md)).toBe('Итог Товар Цена Бетон 5 000 ₽ См. договор, https://example.com/s, картинка . const a = 1; сделано Сноска1.');
  });

  it('shows raw HTML, entities and a single tilde as typed: the chat shows them so', () => {
    expect(visibleText('Файл report-<YYYY-MM-DD>.docx, 1<br>2 &amp; ~одна~')).toBe('Файл report-<YYYY-MM-DD>.docx, 1<br>2 &amp; ~одна~');
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
