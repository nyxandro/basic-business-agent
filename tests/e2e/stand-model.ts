// The stand-in model of the browser stand: answers by keywords of the last message, so every
// widget, the confirmation card and an answer that broke can be seen in a real browser.
import type { FakeRequest, FakeTurn, GatewayStreamError } from '../../core/models/fake-openai.ts';
import { WEB_RESEARCH_TOOL, WIDGET_TOOL } from '@bba/contracts';
import type { FetchedPage, PageReader } from '../../core/web/fetch.ts';
import type { WebSearcher } from '../../core/web/search.ts';
import { BROKEN_SCREEN, DEAL_CARD, DEALS_TABLE, NEW_REQUEST_FORM, OFFER_CALCULATOR, REVENUE_CHART, WHOM_FIRST } from './stand-screens.ts';

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

// The internet of the stand (spec, section 8.30): «в интернете» in a message sends the researcher to
// a made-up shop. The search and the page each take a while, so the live block of the search shows
// its query and its site in a real browser.
export const STAND_WEB_QUERY = 'профнастил С21 цена';
export const STAND_WEB_PAGE = { address: 'https://example.com/c21', title: 'Профнастил С21 — цены' };
export const STAND_WEB_ANSWER = 'Профнастил С21 стоит 520 ₽ за лист, источник — example.com.';
export const STAND_NO_WEB = 'Интернета у меня нет: отвечу только по тому, что знаю.';
const WEB_STEP_MS = 4000;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const standWeb: { searcher: WebSearcher; reader: PageReader } = {
  searcher: {
    search: async () => {
      await pause(WEB_STEP_MS);
      return [{ title: STAND_WEB_PAGE.title, address: STAND_WEB_PAGE.address, snippet: 'от 520 ₽', date: null }];
    },
  },
  reader: {
    read: async (address, offset): Promise<FetchedPage> => {
      await pause(WEB_STEP_MS);
      const text = 'Профнастил С21: 520 ₽ за лист.';
      return { address, final_address: address, title: STAND_WEB_PAGE.title, kind: 'html', text, from: offset, to: offset + text.length, total_chars: text.length };
    },
  },
};

// The researcher of the internet gets its own instructions and the task only (core/web/research.ts):
// it searches, reads the page it found and answers with the source.
const isResearcher = (req: FakeRequest) => textOf(req.messages[0]?.content).includes('Ты — исследователь');
function standResearcher(req: FakeRequest): FakeTurn {
  if (req.messages.at(-1)?.role !== 'tool') return call('web_search', { query: STAND_WEB_QUERY });
  if (lastCallName(req) === 'web_search') return call('web_fetch', { address: STAND_WEB_PAGE.address });
  return { text: `Профнастил С21 — 520 ₽ за лист (${STAND_WEB_PAGE.address}).` };
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
  if (isResearcher(req)) return standResearcher(req);
  const last = req.messages.at(-1);
  if (last?.role === 'tool') {
    const result = textOf(last.content);
    if (lastCallName(req) === WEB_RESEARCH_TOOL) return { text: STAND_WEB_ANSWER };
    if (lastCallName(req)?.endsWith('execute_command')) return call('show_file', { path: STAND_DOCUMENT });
    // The memory of the project or of the person (spec, section 8.26).
    if (lastCallName(req)?.endsWith('_memory')) return { text: /"error":\s*true/.test(result) ? 'Не получилось запомнить.' : 'Запомнил.' };
    if (lastCallName(req) === WIDGET_TOOL.render) return { text: /"shown":\s*true/.test(result) ? 'Готово, показал выше.' : 'Экран не получился, отвечу текстом: карты складов у меня нет.' };
    if (lastCallName(req) === 'show_file') return { text: /"shown":\s*true/.test(result) ? 'Готово: документ ниже, его можно скачать.' : 'Не получилось сделать документ.' };
    if (/not approved|declin|отклон|отмен/i.test(result)) return { text: 'Хорошо, не отправляю.' };
    if (/waitForAnswer/.test(result)) return { text: 'Жду вашего ответа.' };
    if (/sent/.test(result)) return { text: 'Письмо отправлено.' };
    return { text: 'Готово, показал выше.' };
  }
  const text = textOf([...req.messages].reverse().find((m) => m.role === 'user')?.content).toLowerCase();
  // «Запомни: …» — into the project's memory in its conversation; outside a project the agent says where it can.
  if (text.startsWith('запомни')) {
    const fact = textOf([...req.messages].reverse().find((m) => m.role === 'user')?.content).split('\n')[0]!.replace(/^запомни[:,]?\s*/i, '').trim();
    if (!req.tools?.some((x) => x.function.name === 'project_memory')) return { text: 'Факты о работе могу запомнить в проекте.' };
    return call('project_memory', { operations: [{ action: 'add', text: fact }] });
  }
  if (text.includes('документ word')) {
    const tool = req.tools?.map((x) => x.function.name).find((n) => n.endsWith('execute_command'));
    // An agent with «Доступ к выполнению команд терминала» switched off has no commands (spec, section 8.30).
    if (!tool) return { text: 'Команд у меня нет: документ Word сделать не могу.' };
    return call(tool, { command: MAKE_DOCUMENT });
  }
  if (text.includes('в интернете')) {
    if (!req.tools?.some((x) => x.function.name === WEB_RESEARCH_TOOL)) return { text: STAND_NO_WEB };
    return call(WEB_RESEARCH_TOOL, { task: 'Найди цену профнастила С21, с адресами страниц' });
  }
  const screen = widgetFor(text);
  if (screen) {
    // An agent with «Виджеты в чате» switched off has no render_ui (spec, section 8.31).
    if (!req.tools?.some((x) => x.function.name === WIDGET_TOOL.render)) return { text: 'Виджетов у меня нет, отвечаю текстом: Поставка бетона, ООО «Пример», 120 000 ₽.' };
    return call(WIDGET_TOOL.render, screen);
  }
  if (text.includes('почтальон') && req.tools?.some((x) => x.function.name === 'agent-mailer')) return call('agent-mailer', { prompt: 'Отправь письмо клиенту client@example.com' });
  if (text.includes('письм')) return call('mail_send', { to: 'client@example.com', text: 'Добрый день! Напоминаю о встрече.' });
  if (text.includes('сделк')) return call('crm_search', { q: 'без движения' });
  return { text: `Вы написали: «${text.slice(0, 200)}». Попробуйте слова «таблица», «график», «карточка», «выбор», «форма», «калькулятор», «письмо» или «сделки».`, chunkSize: 6, delayMs: 300 };
}

// The screen of the words of a message, if any.
function widgetFor(text: string): Record<string, unknown> | null {
  if (text.includes('калькулятор')) return OFFER_CALCULATOR;
  if (text.includes('таблиц')) return DEALS_TABLE;
  if (text.includes('сломан')) return BROKEN_SCREEN;
  if (text.includes('график')) return REVENUE_CHART;
  if (text.includes('карточк')) return DEAL_CARD;
  if (text.includes('выбор')) return WHOM_FIRST;
  if (text.includes('форм')) return NEW_REQUEST_FORM;
  return null;
}
