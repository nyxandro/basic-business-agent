// The stand-in model of the browser stand: answers by keywords of the last message, so every
// block of the catalog, the confirmation card and an answer that broke can be seen in a real browser.
import type { FakeRequest, FakeTurn, GatewayStreamError } from '../../core/models/fake-openai.ts';

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

// «документ word» (spec, section 8.18): the agent writes a Word file in the sandbox with the docx
// package the document skills use, then shows it with «Скачать».
export const STAND_DOCUMENT = 'КП для ООО «Ёлка».docx';
const MAKE_DOCUMENT =
  `node -e "const d = require('docx'); const doc = new d.Document({ sections: [{ children: [new d.Paragraph('Коммерческое предложение для ООО Ёлка')] }] }); ` +
  `d.Packer.toBuffer(doc).then((b) => require('fs').writeFileSync(process.argv[1], b))" '${STAND_DOCUMENT}'`;

function lastCallName(req: FakeRequest): string | undefined {
  const calls = [...req.messages].reverse().find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))?.tool_calls as { function: { name: string } }[] | undefined;
  return calls?.at(-1)?.function.name;
}

// What LiteLLM sends inside the stream when the provider goes away mid-answer (core/models/gateway.test.ts).
const BREAK: GatewayStreamError = { message: 'litellm.APIConnectionError: APIConnectionError: GroqException - Connection closed.', type: 'internal_server_error', param: null, code: '500' };
export const AFTER_ONE_BREAK = 'Ответ дошёл целиком, хотя модель один раз оборвала его.';
export const AFTER_ANSWER_AGAIN = 'Ответ после «Ответить заново».';

// A repeated model call sends the same request, so the attempts are counted by the question:
// «обрыв один раз» breaks once (the server asks again and the answer arrives), «обрыв дважды»
// breaks twice (the answer stays broken until «Ответить заново»).
export function createStandModel(): (req: FakeRequest) => FakeTurn {
  const attempts = new Map<string, number>();
  return (req) => {
    const question = textOf([...req.messages].reverse().find((m) => m.role === 'user')?.content).toLowerCase();
    const breaks = question.includes('обрыв один раз') ? 1 : question.includes('обрыв дважды') ? 2 : 0;
    if (breaks === 0 || req.messages.at(-1)?.role === 'tool') return standModel(req);
    const attempt = (attempts.get(question) ?? 0) + 1;
    attempts.set(question, attempt);
    if (attempt <= breaks) return { text: 'Начинаю отвечать на вопрос', chunkSize: 6, delayMs: 300, cut: BREAK };
    return { text: breaks === 1 ? AFTER_ONE_BREAK : AFTER_ANSWER_AGAIN, chunkSize: 6, delayMs: 300 };
  };
}

// The naming call of a conversation (core/chat/naming.ts) on the stand: a greeting is no task yet
// («-», the name stays), anything else is named by the person's last message — so a conversation of
// any scenario keeps the words of its question in «Недавние».
const GREETING = /^(привет|здравствуй|добрый день|как дела|что ты умеешь)[\s!?.,]*$/i;
export function standNaming(req: FakeRequest): FakeTurn {
  const said = textOf(req.messages.at(-1)?.content)
    .split('\n')
    .filter((line) => line.startsWith('Сотрудник: '))
    .map((line) => line.slice('Сотрудник: '.length).trim());
  const last = said.at(-1) ?? '';
  return { text: last === '' || GREETING.test(last) ? '-' : last };
}

function standModel(req: FakeRequest): FakeTurn {
  const last = req.messages.at(-1);
  if (last?.role === 'tool') {
    const result = textOf(last.content);
    if (lastCallName(req)?.endsWith('execute_command')) return call('show_file', { path: STAND_DOCUMENT });
    if (lastCallName(req) === 'show_file') return { text: /"shown":\s*true/.test(result) ? 'Готово: документ ниже, его можно скачать.' : 'Не получилось сделать документ.' };
    if (/not approved|declin|отклон|отмен/i.test(result)) return { text: 'Хорошо, не отправляю.' };
    if (/waitForAnswer/.test(result)) return { text: 'Жду вашего ответа.' };
    if (/sent/.test(result)) return { text: 'Письмо отправлено.' };
    return { text: 'Готово, показал выше.' };
  }
  const text = textOf([...req.messages].reverse().find((m) => m.role === 'user')?.content).toLowerCase();
  if (text.includes('документ word')) {
    const tool = req.tools?.map((x) => x.function.name).find((n) => n.endsWith('execute_command'));
    if (!tool) return { text: 'У этого стенда нет рабочей папки.' };
    return call(tool, { command: MAKE_DOCUMENT });
  }
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
