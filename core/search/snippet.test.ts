import { describe, expect, it } from 'vitest';
import { SNIPPET_RADIUS, snippetOf, type MessageText } from './snippet.ts';

const user = (text: string): MessageText => ({ role: 'user', text });
const agent = (text: string): MessageText => ({ role: 'assistant', text });
const MARKS = /\*\*|__|~~|`|\||^#|\]\(|^>/m;

describe('the piece of text of a found conversation', () => {
  it('shows an agent’s answer as the chat does, without Markdown (screenshot of 16.11)', () => {
    const answer = 'Вот что я реально умею. **Из инструментов:**\n1. **Заметки** — вести персональные заметки с поиском по ним.\n2. **Файлы** — читать и писать документы Word.';
    const piece = snippetOf([user('Что ты умеешь?'), agent(answer)], 'Что ты умеешь', ['заметки']);
    expect(piece).toContain('Из инструментов: Заметки — вести персональные заметки');
    expect(piece).not.toMatch(MARKS);
    expect(piece.length).toBeLessThanOrEqual(2 * SNIPPET_RADIUS + 2);
  });

  it('shows the person’s own text as typed: the chat does not read it as Markdown', () => {
    expect(snippetOf([user('Цена *за* штуку и **итого** по смете')], 'Смета', ['итого'])).toBe('Цена *за* штуку и **итого** по смете');
  });

  it('finds the place deep in a long answer: a table row keeps no pipes, the cut ends are marked', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `| Позиция ${i} | ${i * 10} ₽ |`);
    const answer = ['Вступление. '.repeat(1500), '', '| Товар | Цена |', '|---|---|', ...rows, '| Арматура А500С | 900 ₽ |', '', 'Хвост. '.repeat(1500)].join('\n');
    const piece = snippetOf([agent(answer)], 'Смета', ['арматура']);
    expect(piece).toContain('Арматура А500С 900 ₽');
    expect(piece).not.toMatch(MARKS);
    expect(piece.startsWith('…')).toBe(true);
    expect(piece.endsWith('…')).toBe(true);
  });

  it('prefers a word not already in the title', () => {
    const piece = snippetOf([user('Договор поставки готов?'), agent('Да. Поставщик — ООО **Стройресурс**, срок 10 дней.')], 'Договор', ['договор', 'стройресурс']);
    expect(piece).toContain('Стройресурс, срок 10 дней');
  });

  it('starts from the beginning when the word is only in the title or in a link’s address', () => {
    const messages = [user('Пришли отчёт по бетону за октябрь'), agent('Готово: [отчёт](https://example.com/beton.pdf).')];
    expect(snippetOf(messages, 'Бетон', ['beton'])).toBe('Пришли отчёт по бетону за октябрь');
    expect(snippetOf([agent(`## Итог\n\n${'Слово '.repeat(40)}`)], 'Итог', ['итог'])).toMatch(/^Итог Слово .*…$/);
    expect(snippetOf([], 'Пустой', ['пустой'])).toBe('');
  });
});
