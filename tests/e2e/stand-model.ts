// The stand-in model of the browser stand: answers by keywords of the last message, so every
// block of the catalog and the confirmation card can be seen in a real browser.
import type { FakeRequest, FakeTurn } from '../../core/models/fake-openai.ts';

const TABLE = {
  title: 'Сделки без движения',
  columns: [
    { key: 'deal', label: 'Сделка' },
    { key: 'client', label: 'Клиент' },
    { key: 'sum', label: 'Сумма, ₽' },
  ],
  rows: [
    { deal: 'Поставка бетона', client: 'ООО «Пример»', sum: 120000 },
    { deal: 'Аренда крана', client: 'ИП Тестов', sum: 45000 },
  ],
};

const CHART = { title: 'Выручка по месяцам', kind: 'bar', labels: ['Сен', 'Окт', 'Ноя'], series: [{ name: 'Выручка', values: [120, 180, 150] }] };
const CARD = { title: 'Поставка бетона', subtitle: 'ООО «Пример»', fields: [{ label: 'Сумма', value: '120 000 ₽' }, { label: 'Этап', value: 'Переговоры' }] };
const CHOICE = { question: 'Кому написать первым?', options: [{ value: 'primer', label: 'ООО «Пример»' }, { value: 'testov', label: 'ИП Тестов' }] };
const FORM = {
  title: 'Новая заявка',
  fields: [
    { name: 'client', label: 'Клиент', kind: 'text', required: true },
    { name: 'sum', label: 'Сумма', kind: 'number', required: false },
    { name: 'stage', label: 'Этап', kind: 'select', required: true, options: ['Новая', 'Переговоры'] },
  ],
  submitLabel: 'Отправить',
};

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: { text?: unknown }) => (typeof p?.text === 'string' ? p.text : '')).join(' ');
  return '';
}

const call = (name: string, args: Record<string, unknown>): FakeTurn => ({ toolCalls: [{ name, args }] });

export function standModel(req: FakeRequest): FakeTurn {
  const last = req.messages.at(-1);
  if (last?.role === 'tool') {
    const result = textOf(last.content);
    if (/not approved|declin|отклон|отмен/i.test(result)) return { text: 'Хорошо, не отправляю.' };
    if (/waitForAnswer/.test(result)) return { text: 'Жду вашего ответа.' };
    if (/sent/.test(result)) return { text: 'Письмо отправлено.' };
    return { text: 'Готово, показал выше.' };
  }
  const text = textOf([...req.messages].reverse().find((m) => m.role === 'user')?.content).toLowerCase();
  if (text.includes('таблиц')) return call('show_table', TABLE);
  if (text.includes('сломан')) return call('show_chart', { kind: 'bar', labels: ['Сен', 'Окт'], series: [{ name: 'Выручка', values: [1] }] });
  if (text.includes('график')) return call('show_chart', CHART);
  if (text.includes('карточк')) return call('show_card', CARD);
  if (text.includes('выбор')) return call('ask_choice', CHOICE);
  if (text.includes('форм')) return call('ask_form', FORM);
  if (text.includes('почтальон') && req.tools?.some((x) => x.function.name === 'agent-mailer')) return call('agent-mailer', { prompt: 'Отправь письмо клиенту client@example.com' });
  if (text.includes('письм')) return call('mail_send', { to: 'client@example.com', text: 'Добрый день! Напоминаю о встрече.' });
  if (text.includes('сделк')) return call('crm_search', { q: 'без движения' });
  return { text: `Вы написали: «${text.slice(0, 200)}». Попробуйте слова «таблица», «график», «карточка», «выбор», «форма», «письмо» или «сделки».`, chunkSize: 6, delayMs: 300 };
}
