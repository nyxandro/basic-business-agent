// The screens the stand-in model draws with render_ui (spec, section 8.31), by the words of the scenarios: a table,
// a chart, a card, a choice, a form and a calculator, each passing the server's check as a live model's would.
const screen = (surfaceId: string, components: Record<string, unknown>[], dataModel?: Record<string, unknown>) => ({
  operations: [{ version: '1.0', createSurface: { surfaceId, ...(dataModel ? { dataModel } : {}), components } }],
});

const cell = (id: string, text: string, header = false) => ({ id, component: 'TableCell', ...(header ? { header: true } : {}), text });

export const DEALS_TABLE = screen('deals', [
  { id: 'root', component: 'Table', caption: 'Сделки без движения', children: ['head', 'body'] },
  { id: 'head', component: 'TableSection', header: true, children: ['hr'] },
  { id: 'hr', component: 'TableRow', header: true, children: ['h1', 'h2', 'h3'] },
  cell('h1', 'Сделка', true),
  cell('h2', 'Клиент', true),
  cell('h3', 'Сумма', true),
  { id: 'body', component: 'TableSection', children: ['r1', 'r2'] },
  { id: 'r1', component: 'TableRow', children: ['r1a', 'r1b', 'r1c'] },
  cell('r1a', 'Поставка бетона'),
  cell('r1b', 'ООО «Пример»'),
  cell('r1c', '120 000 ₽'),
  { id: 'r2', component: 'TableRow', children: ['r2a', 'r2b', 'r2c'] },
  cell('r2a', 'Аренда крана'),
  cell('r2b', 'ИП Тестов'),
  cell('r2c', '45 000 ₽'),
]);

export const REVENUE_CHART = screen('revenue', [
  {
    id: 'root',
    component: 'Chart',
    title: 'Выручка по месяцам',
    chartType: 'bar',
    xKey: 'month',
    series: [{ key: 'revenue', label: 'Выручка' }],
    data: [
      { month: 'Сен', revenue: 120 },
      { month: 'Окт', revenue: 180 },
      { month: 'Ноя', revenue: 150 },
    ],
  },
]);

export const DEAL_CARD = screen('deal', [
  { id: 'root', component: 'Card', children: ['title', 'client', 'sum', 'stage'] },
  { id: 'title', component: 'Title', text: 'Поставка бетона' },
  { id: 'client', component: 'Text', text: 'ООО «Пример»' },
  { id: 'sum', component: 'Text', text: 'Сумма: 120 000 ₽' },
  { id: 'stage', component: 'Badge', label: 'Переговоры', color: 'info' },
]);

const choose = (id: string, label: string) => ({ id, component: 'Button', label, onClick: { event: { name: 'choose', userMessage: `Пишем первым: ${label}` } } });

export const WHOM_FIRST = screen('whom', [
  { id: 'root', component: 'Card', children: ['question', 'options'] },
  { id: 'question', component: 'Title', text: 'Кому написать первым?' },
  { id: 'options', component: 'Row', children: ['primer', 'testov'] },
  choose('primer', 'ООО «Пример»'),
  choose('testov', 'ИП Тестов'),
]);

export const NEW_REQUEST_FORM = screen(
  'request',
  [
    { id: 'root', component: 'Card', children: ['form'] },
    {
      id: 'form',
      component: 'Form',
      children: ['title', 'client', 'stage', 'send'],
      onSubmit: { event: { name: 'submit', userMessage: 'Новая заявка', context: { client: { '@path': '/client' }, stage: { '@path': '/stage' } } } },
    },
    { id: 'title', component: 'Title', text: 'Новая заявка' },
    { id: 'client', component: 'TextField', label: 'Клиент', value: { '@path': '/client' } },
    { id: 'stage', component: 'SegmentedControl', label: 'Этап', value: { '@path': '/stage' }, options: [{ value: 'Новая', label: 'Новая' }, { value: 'Переговоры', label: 'Переговоры' }] },
    { id: 'send', component: 'Button', label: 'Отправить', variant: 'primary', submit: true },
  ],
  { client: '', stage: 'Новая' },
);

// The total is computed in the browser: moving the slider changes it without the agent.
export const OFFER_CALCULATOR = screen(
  'offer',
  [
    { id: 'root', component: 'Card', children: ['title', 'seats', 'total', 'make'] },
    { id: 'title', component: 'Title', text: 'КП для ООО «Пример»' },
    { id: 'seats', component: 'Slider', label: 'Сотрудников', min: 1, max: 50, step: 1, value: { '@path': '/seats' } },
    { id: 'total', component: 'Row', justify: 'spaceBetween', children: ['totalLabel', 'totalValue'] },
    { id: 'totalLabel', component: 'Caption', text: 'Итого в месяц' },
    {
      id: 'totalValue',
      component: 'Text',
      text: { '@call': 'formatCurrency', args: { value: { '@call': 'calc', args: { expression: 'seats * 2900', seats: { '@path': '/seats' } } }, currency: 'RUB', decimals: 0 } },
    },
    { id: 'make', component: 'Button', label: 'Оформить КП', variant: 'primary', onClick: { event: { name: 'offer', userMessage: 'Готовь КП', context: { seats: { '@path': '/seats' } } } } },
  ],
  { seats: 15 },
);

// A screen the server refuses: there is no map among the components.
export const BROKEN_SCREEN = screen('map', [{ id: 'root', component: 'Map', title: 'Склады на карте' }]);
