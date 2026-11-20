// Widgets in the chat (spec, section 8.31): the agent of a chat gets `ui_components` and `render_ui` with «Виджеты в
// чате» on, a screen is checked against the catalog before the person sees it, and the descriptions of components of
// earlier turns are not sent to the model again.
import { randomUUID } from 'node:crypto';
import { WIDGET_CATALOG_ID, WIDGET_COMPONENTS, WIDGET_TOOL } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../server/test-app.ts';
import { checkScreen, componentIndex, componentsGuide, widgetManifest, type ShownScreens } from './catalog.ts';
import { DESCRIPTION_DROPPED, dropOldDescriptions } from './history.ts';
import { WIDGETS_OFF } from './prompt.ts';

let t: TestApp;
let olga: string;
let admin: string;

interface AguiEvent {
  type: string;
  toolCallName?: string;
  toolCallId?: string;
  content?: string;
}

async function run(text: string, threadId = randomUUID()): Promise<AguiEvent[]> {
  const res = await t.call('POST', '/app/api/copilotkit/agent/sales/run', {
    cookie: olga,
    body: { threadId, runId: randomUUID(), messages: [{ id: randomUUID(), role: 'user', content: text }], tools: [], context: [], state: {}, forwardedProps: {} },
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
    // A placeholder of the guide taken for a function (live run 20.11): the browser would not draw the part.
    expect(problems([surface([{ id: 'root', component: 'Caption', text: { '@call': 'formatString', args: { value: 'В месяц: ${fn(value: m)}' } } }])])).toMatch(/«fn»/);
    expect(problems([surface([{ id: 'root', component: 'Caption', text: { '@call': 'formatString', args: { value: "${formatCurrency(value: /total, currency: 'RUB', decimals: 0)}" } } }], { dataModel: { total: 1 } })])).toEqual([]);
  });

  it('changes a screen of the same run in place, and refuses a second screen of the same name', () => {
    const shown: ShownScreens = new Map();
    expect(checkScreen(CALCULATOR, shown)).toMatchObject({ ok: true, created: true });
    const update = { version: '1.0', updateComponents: { surfaceId: 'kp', components: [{ id: 'root', component: 'Card', children: ['seats', 'total', 'note'] }, { id: 'note', component: 'Caption', text: 'Скидка 5%' }] } };
    expect(checkScreen([update], shown)).toEqual({ ok: true, surfaceId: 'kp', created: false });
    expect(checkScreen([{ version: '1.0', updateDataModel: { surfaceId: 'kp', path: '/seats', value: 20 } }], shown)).toMatchObject({ ok: true, created: false });
    // A child of a change must be on the screen as it is after the change.
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
    expect(resultOf(events)).toEqual({ shown: true, surfaceId: 'kp' });
  });

  // A model wrote the list as one JSON string and left out the version mark (live run 20.11): the same screen.
  it('reads a list written as a string and operations without their version', async () => {
    const unmarked = CALCULATOR.map(({ version: _v, ...op }) => op);
    t.model.script({ toolCalls: [{ name: WIDGET_TOOL.render, args: { operations: JSON.stringify(unmarked) } }] }, { text: 'Готово.' });
    expect(resultOf(await run('Посчитай КП'))).toEqual({ shown: true, surfaceId: 'kp' });
  });

  it('lets a later call of the same answer change the screen in place', async () => {
    const update = { version: '1.0', updateDataModel: { surfaceId: 'kp', path: '/seats', value: 20 } };
    t.model.script({ toolCalls: [{ name: WIDGET_TOOL.render, args: { operations: CALCULATOR } }] }, { toolCalls: [{ name: WIDGET_TOOL.render, args: { operations: [update] } }] }, { text: 'Поправил.' });
    const results = (await run('Посчитай КП')).filter((e) => e.type === 'TOOL_CALL_RESULT').map((e) => JSON.parse(e.content!) as unknown);
    expect(results).toEqual([{ shown: true, surfaceId: 'kp' }, { shown: true, surfaceId: 'kp' }]);
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

  it('switched off: no tools, and the agent is told so', async () => {
    await t.call('PUT', '/app/api/admin/agents/sales/abilities', { cookie: admin, body: { widgets: false } });
    t.model.script({ text: 'Отвечу текстом.' });
    await run('Посчитай КП');
    expect(offered(-1)).not.toContain(WIDGET_TOOL.render);
    expect(offered(-1)).not.toContain(WIDGET_TOOL.components);
    expect(systemOf()).toContain(JSON.stringify(WIDGETS_OFF).slice(1, -1));
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
