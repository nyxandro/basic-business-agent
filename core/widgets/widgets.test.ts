// Widgets in the chat (spec, section 8.31): the agent of a chat gets `ui_components` and `render_ui` with «Виджеты в
// чате» on, a screen is checked against the catalog before the person sees it, and the descriptions of components of
// earlier turns are not sent to the model again.
import { randomUUID } from 'node:crypto';
import { operationsOf, WIDGET_CATALOG_ID, WIDGET_COMPONENTS, WIDGET_TOOL } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { checkScreen, componentIndex, componentsGuide, widgetManifest, type ShownScreens } from './catalog.ts';
import { DESCRIPTION_DROPPED, dropOldDescriptions } from './history.ts';
import { WIDGETS_OFF } from './prompt.ts';
import { SHOWN_NOTE } from './tools.ts';

let t: TestApp;
let olga: string;
let admin: string;

interface AguiEvent {
  type: string;
  toolCallName?: string;
  toolCallId?: string;
  content?: string;
}

async function run(text: string, threadId = randomUUID(), forwardedProps: Record<string, unknown> = {}): Promise<AguiEvent[]> {
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', {
    cookie: olga,
    body: { threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: text }], tools: [], context: [], state: {}, forwardedProps },
  });
  expect(res.status).toBe(200);
  return (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as AguiEvent);
}

const resultOf = (events: AguiEvent[]) => JSON.parse(events.find((e) => e.type === 'TOOL_CALL_RESULT')!.content!) as Record<string, unknown>;
const offered = (request: number) => t.model.requests.at(request)!.tools?.map((x) => x.function.name) ?? [];
const systemOf = () => JSON.stringify(t.model.requests.at(-1)!.messages.filter((m) => m.role === 'system'));

const surface = (components: unknown[], extra: Record<string, unknown> = {}) => ({ version: '1.0', createSurface: { surfaceId: 'kp', components, ...extra } });
const CALCULATOR = [
  surface(
    [
      { id: 'root', component: 'Card', children: ['seats', 'total'] },
      { id: 'seats', component: 'Slider', label: 'Сотрудников', min: 1, max: 50, value: { '@path': '/seats' } },
      { id: 'total', component: 'Text', text: { '@call': 'formatString', args: { value: 'Сотрудников: ${/seats}' } } },
    ],
    { dataModel: { seats: 15 } },
  ),
];

beforeAll(async () => {
  t = await createTestApp();
  await t.createUser({ email: 'boss@example.com', name: 'Игорь', roleIds: [await t.roleId('superadmin')] });
  const olgaId = await t.createUser({ email: 'olga@example.com', name: 'Ольга' });
  const dep = (await t.db.query<{ id: string }>(`INSERT INTO app.departments (name) VALUES ('Продажи') RETURNING id`)).rows[0]!.id;
  await t.db.query('INSERT INTO app.department_members (department_id, user_id) VALUES ($1, $2)', [dep, olgaId]);
  await t.db.query(`INSERT INTO app.department_agents (department_id, agent_id) VALUES ($1, 'sales')`, [dep]);
  olga = await t.signIn('olga@example.com');
  admin = await t.signIn('boss@example.com');
});
afterAll(async () => {
  await t.close();
});

describe('the catalog of widgets', () => {
  it('holds the 43 approved components and CopilotKit’s functions, under our catalog on top of the standard one', () => {
    const manifest = widgetManifest();
    expect(manifest.catalogId).toBe(WIDGET_CATALOG_ID);
    expect(manifest.catalogIds).toEqual([WIDGET_CATALOG_ID, 'copilotkit/standard@1']);
    expect(Object.keys(manifest.components).sort()).toEqual([...WIDGET_COMPONENTS].sort());
    expect(Object.keys(manifest.functions)).toEqual(expect.arrayContaining(['calc', 'formatCurrency', 'formatDate', 'pluralize', 'required']));
    expect(componentIndex().split('\n')).toHaveLength(WIDGET_COMPONENTS.length);
  });

  it('describes only the named components', () => {
    const guide = componentsGuide(['Slider', 'Card']);
    expect(guide).toContain('render_ui');
    expect(guide).toMatch(/Slider/);
    expect(guide).not.toMatch(/EntityCard/);
    // M11 20.11: CopilotKit's «stream progressively … one updateComponents per child» was taken for a call per part;
    // our line before it says the operations of a screen go in one call.
    expect(guide.indexOf('все операции экрана — в одном вызове')).toBeGreaterThan(-1);
    expect(guide.indexOf('все операции экрана — в одном вызове')).toBeLessThan(guide.indexOf('Stream progressively'));
  });

  it('checks a screen: one surface, its root, the children it names, CopilotKit’s own check', () => {
    expect(checkScreen(CALCULATOR, new Map() as ShownScreens)).toEqual({ ok: true, surfaceId: 'kp', created: true });
    const problems = (ops: Record<string, unknown>[], shown: ShownScreens = new Map()) => {
      const verdict = checkScreen(ops, shown);
      return verdict.ok ? [] : verdict.problems.join('\n');
    };
    expect(problems([surface([{ id: 'main', component: 'Text', text: 'Нет корня' }])])).toMatch(/root/);
    expect(problems([surface([{ id: 'root', component: 'Column', children: ['gone'] }])])).toMatch(/«gone»/);
    expect(problems([surface([{ id: 'root', component: 'Tabs', tabs: [{ title: 'А', child: 'gone' }] }])])).toMatch(/«gone»/);
    expect(problems([surface([{ id: 'root', component: 'Map' }])])).toMatch(/Map/);
    expect(problems([{ version: '1.0', updateComponents: { surfaceId: 'kp', components: [] } }])).toMatch(/createSurface/);
    expect(problems([...CALCULATOR, surface([{ id: 'root', component: 'Text', text: 'Второй' }])])).toMatch(/один экран/);
    expect(problems([...CALCULATOR, { version: '1.0', updateDataModel: { surfaceId: 'other', path: '/seats', value: 3 } }])).toMatch(/«other»/);
    expect(problems([...CALCULATOR, { version: '1.0', deleteSurface: { surfaceId: 'kp' } }])).toMatch(/deleteSurface/);
    // M11 20.11: a change written without its kind, and a screen sent in parts — the reason names the way to write it.
    const unwrapped = problems([{ version: '1.0', surfaceId: 'kp', path: '/seats', value: 3 }]);
    expect(unwrapped).toMatch(/нет вида операции/);
    expect(unwrapped).toContain('"updateDataModel"');
    expect(problems([...CALCULATOR, { version: '1.0', surfaceId: 'kp', path: '/seats', value: 3 }])).toMatch(/операция 2: нет вида операции/);
    expect(problems([surface([{ id: 'root', component: 'Column', children: ['gone'] }])])).toMatch(/весь экран — одним вызовом/);
    // A placeholder of the guide taken for a function (live run 20.11): the browser would not draw the part.
    expect(problems([surface([{ id: 'root', component: 'Caption', text: { '@call': 'formatString', args: { value: 'В месяц: ${fn(value: m)}' } } }])])).toMatch(/«fn»/);
    expect(problems([surface([{ id: 'root', component: 'Caption', text: { '@call': 'formatString', args: { value: "${formatCurrency(value: /total, currency: 'RUB', decimals: 0)}" } } }], { dataModel: { total: 1 } })])).toEqual([]);
  });

  // e2e 20.11: «${formatCurrency(value: ${calc(…)})}» passed the check and the browser showed «this part could not be
  // displayed». The server computes every value of the screen with its initial data, by CopilotKit's own code.
  it('computes the values of a screen with its initial data, as the browser will', () => {
    const problems = (ops: Record<string, unknown>[]) => {
      const verdict = checkScreen(ops, new Map());
      return verdict.ok ? '' : verdict.problems.join('\n');
    };
    const nested = { '@call': 'formatString', args: { value: "Итого: ${formatCurrency(value: ${calc(expression: 'n * 2', n: ${/seats})}, currency: 'RUB')}" } };
    expect(problems([surface([{ id: 'root', component: 'Text', text: nested }], { dataModel: { seats: 15 } })])).toMatch(/компонент «root», поле «text»: formatString/);
    const bad = { '@call': 'calc', args: { expression: 'n * * 2', n: { '@path': '/seats' } } };
    expect(problems([surface([{ id: 'root', component: 'Text', text: bad }], { dataModel: { seats: 15 } })])).toMatch(/поле «text»: calc/);
    // The right way of the same: a call inside a call, and the data changed by a later operation of the call.
    const right = { '@call': 'formatCurrency', args: { value: { '@call': 'calc', args: { expression: 'n * 2900', n: { '@path': '/seats' } } }, currency: 'RUB', decimals: 0 } };
    expect(problems([surface([{ id: 'root', component: 'Text', text: right }], { dataModel: { seats: 15 } }), { version: '1.0', updateDataModel: { surfaceId: 'kp', path: '/seats', value: 20 } }])).toBe('');
    // A template of a list is computed per item, with paths of the item: it is not computed against the whole data.
    const list = [
      { id: 'root', component: 'List', children: { componentId: 'item', path: '/deals' } },
      { id: 'item', component: 'ListItem', label: { '@path': 'name' }, value: { '@call': 'formatCurrency', args: { value: { '@path': 'sum' }, currency: 'RUB' } } },
    ];
    expect(problems([surface(list, { dataModel: { deals: [{ name: 'Поставка', sum: 120000 }] } })])).toBe('');
    // Review 20.11: a pattern of the model runs on the server's only thread — `^(a+)+$` on 40 letters would hold
    // every request for minutes. Values with `regex` are left to the browser.
    const slow = { '@call': 'regex', args: { value: { '@path': '/inn' }, pattern: '^(a+)+$' } };
    const started = performance.now();
    expect(problems([surface([{ id: 'root', component: 'TextField', label: 'ИНН', value: { '@path': '/inn' }, checks: [{ condition: slow, message: 'нет' }] }], { dataModel: { inn: `${'a'.repeat(40)}!` } })])).toBe('');
    expect(performance.now() - started).toBeLessThan(500);
  });

  // Owner 20.11 («отступы отсутствуют»; the row of key figures was not drawn): the model wrote gaps as words and
  // `wrap: true`. Words of spacing and a yes/no of wrapping are read as CopilotKit means them; anything else the
  // browser's engine would drop is refused by the same engine on the server.
  it('reads gaps written as words and wrap as yes or no, and refuses what the engine of the browser would drop', () => {
    const row = (extra: Record<string, unknown>) => [surface([{ id: 'root', component: 'Row', children: ['a'], ...extra }, { id: 'a', component: 'Text', text: 'А' }])];
    const read = operationsOf({ operations: row({ gap: 'md', padding: 'lg', wrap: true }) });
    expect((read[0]!.createSurface as { components: Record<string, unknown>[] }).components[0]).toMatchObject({ gap: 3, padding: 4, wrap: 'wrap' });
    expect(checkScreen(read, new Map())).toMatchObject({ ok: true });
    const refused = checkScreen(operationsOf({ operations: row({ wrap: 'yes' }) }), new Map());
    expect(refused.ok ? '' : refused.problems.join('\n')).toMatch(/браузер не покажет: component "root": wrap/);
    // A screen whose components come after its createSurface is checked as the browser draws it.
    const later = [{ version: '1.0', createSurface: { surfaceId: 'kp', dataModel: { seats: 1 } } }, { version: '1.0', updateComponents: { surfaceId: 'kp', components: [{ id: 'root', component: 'Text', text: 'А' }] } }];
    expect(checkScreen(later, new Map())).toMatchObject({ ok: true });
  });

  it('changes a screen of the same run in place, and refuses a second screen of the same name', () => {
    const shown: ShownScreens = new Map();
    expect(checkScreen(CALCULATOR, shown)).toMatchObject({ ok: true, created: true });
    const update = { version: '1.0', updateComponents: { surfaceId: 'kp', components: [{ id: 'root', component: 'Card', children: ['seats', 'total', 'note'] }, { id: 'note', component: 'Caption', text: 'Скидка 5%' }] } };
    expect(checkScreen([update], shown)).toEqual({ ok: true, surfaceId: 'kp', created: false });
    expect(checkScreen([{ version: '1.0', updateDataModel: { surfaceId: 'kp', path: '/seats', value: 20 } }], shown)).toMatchObject({ ok: true, created: false });
    // A child of a change must be on the screen as it is after the change.
    // A change the browser's manager would drop, on the screen as it is now.
    const dropped = checkScreen([{ version: '1.0', updateComponents: { surfaceId: 'kp', components: [{ id: 'note', component: 'Caption', text: 'Скидка 5%', size: 'huge' }] } }], shown);
    expect(dropped.ok ? '' : dropped.problems.join('\n')).toMatch(/браузер не покажет: component "note"/);
    const broken = checkScreen([{ version: '1.0', updateComponents: { surfaceId: 'kp', components: [{ id: 'root', component: 'Card', children: ['gone'] }] } }], shown);
    expect(broken.ok ? '' : broken.problems.join('\n')).toMatch(/«gone»/);
    const again = checkScreen(CALCULATOR, shown);
    expect(again.ok ? '' : again.problems.join('\n')).toMatch(/уже показан/);
    // A screen of an earlier answer is not in this run's list.
    const earlier = checkScreen([update], new Map() as ShownScreens);
    expect(earlier.ok ? '' : earlier.problems.join('\n')).toMatch(/экран прошлого ответа/);
  });
});

describe('widgets in a chat', () => {
  // A press of a widget: CopilotKit's browser puts its envelope (catalog, surfaces, the action) into the run, and
  // CopilotKit's runtime would give the model its own `render_ui` and the guide of the whole catalog for that turn.
  it('a press of a widget gets no second render_ui and no CopilotKit guide', async () => {
    const text = (widgetManifest() as unknown as { components: Record<string, unknown> }).components.Text;
    const envelope = {
      '1.0': { supportedCatalogIds: [WIDGET_CATALOG_ID], inlineCatalogs: [{ catalogId: WIDGET_CATALOG_ID, protocolVersion: '1.0', components: { Text: text }, functions: {} }] },
      metadata: { extensions: { copilotkit_format: 3, copilotkit_transport: 'tool', copilotkit_targets: [{ id: 'chat', kind: 'chat' }], copilotkit_surfaces: {}, copilotkit_contextSent: false } },
    };
    t.model.script({ text: 'Принял.' });
    await run('Оформи КП\n\nseats: 20', randomUUID(), { copilotkit: { ui: envelope } });
    // Ours, with the server's check — not CopilotKit's of the same name, which the browser would carry out unchecked.
    const tools = (t.model.requests.at(-1)!.tools ?? []) as unknown as { function: { name: string; description?: string } }[];
    const renders = tools.filter((x) => x.function.name === WIDGET_TOOL.render);
    expect(renders).toHaveLength(1);
    expect(renders[0]!.function.description).toMatch(/^Показать сотруднику виджет/);
    expect(JSON.stringify(t.model.requests.at(-1)!.messages)).not.toContain('Call `render_ui` to show UI');
  });

  it('are offered to the agent of a chat, without the five former blocks, with the rules and the list of components', async () => {
    t.model.script({ text: 'Здравствуйте.' });
    await run('Привет');
    const tools = offered(-1);
    expect(tools).toEqual(expect.arrayContaining([WIDGET_TOOL.components, WIDGET_TOOL.render]));
    for (const former of ['show_table', 'show_chart', 'show_card', 'ask_choice', 'ask_form']) expect(tools).not.toContain(former);
    expect(systemOf()).toContain('## Виджеты в чате');
    expect(systemOf()).toContain('- EntityCard: ');
  });

  it('shows a screen that passes the check', async () => {
    t.model.script({ toolCalls: [{ name: WIDGET_TOOL.render, args: { target: 'chat', operations: CALCULATOR } }] }, { text: 'Двигайте ползунок.' });
    const events = await run('Посчитай КП');
    expect(events.find((e) => e.type === 'TOOL_CALL_START')?.toolCallName).toBe(WIDGET_TOOL.render);
    expect(resultOf(events)).toEqual({ shown: true, surfaceId: 'kp', note: SHOWN_NOTE });
    // M11 20.11: the agent retold the screen in words after 3 screens of 4; the note of the result says not to.
    expect(SHOWN_NOTE).toMatch(/Не пересказывай/);
  });

  // A model wrote the list as one JSON string and left out the version mark (live run 20.11): the same screen.
  it('reads a list written as a string and operations without their version', async () => {
    const unmarked = CALCULATOR.map(({ version: _v, ...op }) => op);
    t.model.script({ toolCalls: [{ name: WIDGET_TOOL.render, args: { operations: JSON.stringify(unmarked) } }] }, { text: 'Готово.' });
    expect(resultOf(await run('Посчитай КП'))).toEqual({ shown: true, surfaceId: 'kp', note: SHOWN_NOTE });
  });

  // M11 20.11: a list with a bracket too many reached the server as a string (none of 11 such strings was JSON) and came
  // back as «expected array», «string <=200 characters» — the reason now points at the brackets and shows the place.
  it('tells the model that the list is not JSON, and shows where', async () => {
    const broken = `${JSON.stringify(CALCULATOR).slice(0, -1)}}]`;
    t.model.script({ toolCalls: [{ name: WIDGET_TOOL.render, args: { operations: broken } }] }, { text: 'Исправлю.' });
    await run('Посчитай КП');
    const toolMessage = String(t.model.requests.at(-1)!.messages.find((m) => m.role === 'tool')?.content);
    expect(toolMessage).toContain('operations — не JSON');
    expect(toolMessage).toContain('скобок');
    // The place of the mistake: the end of the list, where the bracket too many is.
    expect(toolMessage).toContain('/seats}');
    expect(toolMessage).not.toContain('200 characters');
  });

  it('lets a later call of the same answer change the screen in place', async () => {
    const update = { version: '1.0', updateDataModel: { surfaceId: 'kp', path: '/seats', value: 20 } };
    t.model.script({ toolCalls: [{ name: WIDGET_TOOL.render, args: { operations: CALCULATOR } }] }, { toolCalls: [{ name: WIDGET_TOOL.render, args: { operations: [update] } }] }, { text: 'Поправил.' });
    const results = (await run('Посчитай КП')).filter((e) => e.type === 'TOOL_CALL_RESULT').map((e) => JSON.parse(e.content!) as unknown);
    expect(results).toEqual([{ shown: true, surfaceId: 'kp', note: SHOWN_NOTE }, { shown: true, surfaceId: 'kp', note: SHOWN_NOTE }]);
    // The next answer is another run: the screen of this one is not changed from there.
    t.model.script({ toolCalls: [{ name: WIDGET_TOOL.render, args: { operations: [update] } }] }, { text: 'Нарисую заново.' });
    expect(resultOf(await run('Сделай 25'))).toMatchObject({ error: true, code: 'APP_WIDGET_INVALID' });
  });

  it('gives the model the reasons of a screen that fails the check', async () => {
    t.model.script({ toolCalls: [{ name: WIDGET_TOOL.render, args: { operations: [surface([{ id: 'root', component: 'Map' }])] } }] }, { text: 'Отвечу текстом.' });
    const events = await run('Покажи на карте');
    expect(resultOf(events)).toMatchObject({ error: true, code: 'APP_WIDGET_INVALID' });
    const toolMessage = JSON.stringify(t.model.requests.at(-1)!.messages.find((m) => m.role === 'tool')?.content);
    expect(toolMessage).toContain('Map');
    expect(toolMessage).toContain('render_ui заново');
  });

  it('describes the named components and refuses a name that is not in the set', async () => {
    t.model.script({ toolCalls: [{ name: WIDGET_TOOL.components, args: { names: ['Slider', 'Card'] } }] }, { text: 'Готово.' });
    expect(String(resultOf(await run('Нужен калькулятор')).guide)).toContain('Slider');
    t.model.script({ toolCalls: [{ name: WIDGET_TOOL.components, args: { names: ['Map', 'Card'] } }] }, { text: 'Без карты.' });
    expect(resultOf(await run('Нужна карта'))).toMatchObject({ error: true, code: 'APP_WIDGET_UNKNOWN_COMPONENT' });
  });

  it('does not send the descriptions of an earlier turn again, and keeps them in the current one', async () => {
    const threadId = randomUUID();
    t.model.script({ toolCalls: [{ name: WIDGET_TOOL.components, args: { names: ['Slider'] } }] }, { text: 'Описание получил.' });
    await run('Нужен калькулятор', threadId);
    expect(JSON.stringify(t.model.requests.at(-1)!.messages)).toContain('Slider');
    t.model.script({ text: 'Хорошо.' });
    await run('Спасибо', threadId);
    const sent = JSON.stringify(t.model.requests.at(-1)!.messages);
    expect(sent).toContain(DESCRIPTION_DROPPED);
    expect(sent).not.toContain('render_ui` to show UI');
  });

  // Owner, 22.11: with widgets on, data and entities are shown as widgets on the agent's own initiative.
  it('switched on: the agent is told to show data and entities as widgets on its own, not as a wall of text', async () => {
    t.model.script({ text: 'Готово.' });
    await run('Покажи мои сделки');
    const system = systemOf();
    expect(system).toContain('Данные и сущности показывай виджетом, а не простынёй текста — сам, без просьбы сотрудника');
    expect(system).toContain('сделки, клиенты, письма, задачи, документы');
    expect(system).toContain('Попросили ответить текстом — отвечай текстом.');
  });

  it('switched off: no tools, and the agent is told so', async () => {
    await t.call('PUT', '/app/api/admin/agents/sales/abilities', { cookie: admin, body: { widgets: false } });
    t.model.script({ text: 'Отвечу текстом.' });
    await run('Посчитай КП');
    expect(offered(-1)).not.toContain(WIDGET_TOOL.render);
    expect(offered(-1)).not.toContain(WIDGET_TOOL.components);
    expect(systemOf()).toContain(JSON.stringify(WIDGETS_OFF).slice(1, -1));
    expect(systemOf()).not.toContain('Данные и сущности показывай виджетом');
    await t.call('PUT', '/app/api/admin/agents/sales/abilities', { cookie: admin, body: { widgets: true } });
  });
});

describe('the descriptions of earlier turns', () => {
  it('are replaced before the person’s last message only, other tools untouched', () => {
    const description = { type: 'tool-result', toolCallId: '1', toolName: WIDGET_TOOL.components, output: { type: 'json', value: { guide: 'описание' } } };
    const other = { type: 'tool-result', toolCallId: '2', toolName: 'web_research', output: { type: 'json', value: { answer: 'ответ' } } };
    const prompt = [
      { role: 'user', content: [{ type: 'text', text: 'первый' }] },
      { role: 'tool', content: [description, other] },
      { role: 'user', content: [{ type: 'text', text: 'второй' }] },
      { role: 'tool', content: [description] },
    ];
    const out = dropOldDescriptions(prompt)!;
    expect(out[1]!.content).toEqual([{ ...description, output: { type: 'text', value: DESCRIPTION_DROPPED } }, other]);
    expect(out[3]).toBe(prompt[3]);
    expect(dropOldDescriptions(prompt.slice(2))).toBeNull();
  });
});
