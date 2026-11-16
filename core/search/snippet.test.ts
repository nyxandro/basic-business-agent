import { describe, expect, it } from 'vitest';
import { SNIPPET_RADIUS, snippetOf, type MessageText } from './snippet.ts';
import { buildVariants } from './variants.ts';

const user = (text: string): MessageText => ({ role: 'user', text });
const agent = (text: string): MessageText => ({ role: 'assistant', text });
const w = (query: string) => buildVariants(query, new Map());
const MARKS = /\*\*|__|~~|`|\||^#|\]\(|^>/m;

describe('the piece of text of a found conversation', () => {
  it('shows an agent’s answer as the chat does, without Markdown (screenshot of 16.11)', () => {
    const answer = 'Вот что я реально умею. **Из инструментов:**\n1. **Заметки** — вести персональные заметки с поиском по ним.\n2. **Файлы** — читать и писать документы Word.';
    const piece = snippetOf([agent(answer)], 'Что ты умеешь?', 'Что ты умеешь', w('заметки'));
    expect(piece).toContain('Из инструментов: Заметки — вести персональные заметки');
    expect(piece).not.toMatch(MARKS);
    expect(piece.length).toBeLessThanOrEqual(2 * SNIPPET_RADIUS + 2);
  });

  it('shows the person’s own text as typed: the chat does not read it as Markdown', () => {
    expect(snippetOf([user('Цена *за* штуку и **итого** по смете')], null, 'Смета', w('итого'))).toBe('Цена *за* штуку и **итого** по смете');
  });

  it('keeps a long table a table: its header is far above the found row', () => {
    const rows = Array.from({ length: 80 }, (_, i) => `| Позиция номер ${i} | ${i * 10} ₽ | на складе |`);
    const answer = ['Вступление. '.repeat(50), '', '| Товар | Цена | Где |', '|---|---|---|', ...rows, '| Арматура А500С | 900 ₽ | на складе |', '', 'Хвост. '.repeat(1500)].join('\n');
    const piece = snippetOf([agent(answer)], null, 'Смета', w('арматура'));
    expect(piece).toContain('Арматура А500С 900 ₽ на складе');
    expect(piece).not.toContain('Товар');
    expect(piece).not.toMatch(MARKS);
    expect(piece.startsWith('…')).toBe(true);
    expect(piece.endsWith('…')).toBe(true);
  });

  it('keeps a table whose divider opens the window', () => {
    // 300 characters before the word fall on the divider: the window starts there, below the header.
    const answer = `Вступление.\n| Товар | Цена |\n|---|---|\n| ${'позиция '.repeat(37)}арматура | 900 ₽ |`;
    const piece = snippetOf([agent(answer)], null, 'Смета', w('арматура'));
    expect(piece).toContain('позиция арматура 900 ₽');
    expect(piece).not.toMatch(MARKS);
    expect(piece).not.toContain('---');
  });

  it('knows a code block with blank lines began before the window: the text after it is Markdown again', () => {
    const answer = `\`\`\`md\n${'строка кода\n\n'.repeat(200)}\`\`\`\n\nЗдесь **важно**: арматура \`VAR_1\` и [договор](https://example.com/d.pdf).`;
    const piece = snippetOf([agent(answer)], null, 'Код', w('арматура'));
    expect(piece).toContain('Здесь важно: арматура VAR_1 и договор.');
    expect(piece).not.toMatch(MARKS);
  });

  it('prefers a word not already in the title', () => {
    const piece = snippetOf([user('Договор поставки готов?'), agent('Да. Поставщик — ООО **Стройресурс**, срок 10 дней.')], 'Договор поставки готов?', 'Договор', w('договор стройресурс'));
    expect(piece).toContain('Стройресурс, срок 10 дней');
  });

  it('goes to the next word when the first is only in links’ addresses', () => {
    const links = Array.from({ length: 4 }, (_, i) => agent(`Файл ${i}: [отчёт](https://example.com/beton-${i}.pdf).`));
    expect(snippetOf([...links, user('Сколько цемента надо на фундамент?')], null, 'Расчёт', w('beton цемент'))).toBe('Сколько цемента надо на фундамент?');
  });

  it('starts from the conversation’s first words when the word is only in the title or in markup', () => {
    expect(snippetOf([], 'Пришли отчёт по бетону за октябрь', 'Бетон', w('бетон'))).toBe('Пришли отчёт по бетону за октябрь');
    expect(snippetOf([agent('Готово: [отчёт](https://example.com/beton.pdf).')], 'Пришли отчёт', 'Отчёт', w('beton'))).toBe('Пришли отчёт');
    const long = 'Длинное слово '.repeat(20);
    const piece = snippetOf([], long, 'Итог', w('итог'));
    // 120 characters of the first words (a space at the cut is trimmed), not 60.
    expect(piece.length).toBeGreaterThanOrEqual(2 * SNIPPET_RADIUS);
    expect(piece.length).toBeLessThanOrEqual(2 * SNIPPET_RADIUS + 1);
    expect(piece.endsWith('…')).toBe(true);
    expect(snippetOf([], null, 'Пустой', w('пустой'))).toBe('');
  });

  it('starts close before the word and cuts at the edges of words, not inside them', () => {
    const text = `${'Длинное вступление без нужного слова. '.repeat(5)}Здесь арматура А500С лежит на складе. ${'Длинный хвост ответа агента. '.repeat(10)}`;
    const piece = snippetOf([user(text)], null, 'Смета', w('арматура'));
    expect(piece.indexOf('арматура')).toBeLessThanOrEqual(21);
    expect(piece).toMatch(/^…(\S+ )+арматура/);
    // The words at both cuts are whole.
    const inner = piece.slice(1, -1);
    expect(text).toContain(` ${inner} `);
  });

  it('never cuts an emoji in half at the ends of the piece', () => {
    // Both ends of ±60 around the word fall between the two halves of an emoji.
    const text = `x${'😀'.repeat(100)} договор y${'😀'.repeat(100)}`;
    const piece = snippetOf([user(text)], null, 'Смайлы', w('договор'));
    expect(piece).toContain('договор');
    expect(piece.isWellFormed()).toBe(true);
  });
});
