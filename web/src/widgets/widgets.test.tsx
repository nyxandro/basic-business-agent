// Widgets in the chat (spec, section 8.31): the set of components is the approved one, the operations of a call reach
// CopilotKit's engine one component at a time under the call's own surface, a later call of the same answer changes the
// screen in place, and the block says what happened when there is no screen to show.
import { GENUI_TOOL, WIDGET_CATALOG_ID, WIDGET_COMPONENTS, WIDGET_TOOL } from '@bba/contracts';
import { standardUI } from '@copilotkit/react-core/generative-ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnStateContext, type TurnState } from '../chat/call-progress.ts';
import { toolSummary } from '../chat/tool-summary.ts';
import { widgetsUI } from './catalog.ts';
import { drawableOperations, laterChanges } from './operations.ts';
import { BUSY_CODE, BusyPress, useBusyGuard } from './busy.tsx';
import { widgetOverrides } from './overrides.tsx';
import { replyHead, screensOfAnswer, sendingControls, WidgetReplyContext, widgetReply } from './reply.ts';
import { WidgetCall } from './WidgetCall.tsx';

const ingest = vi.fn();
const setActiveThread = vi.fn();
let messages: unknown[] = [];
let running = false;
// The engine's answer to a press of the stub: «busy» while the agent answers, sent once it is done.
const pressed = vi.fn((_args: unknown) => (running ? BUSY : { ok: true as const, result: undefined }));

const addMessage = vi.fn();
const runAgent = vi.fn(() => Promise.resolve());
vi.mock('@copilotkit/react-core', async (original) => ({
  ...(await original<typeof import('@copilotkit/react-core')>()),
  useAgent: () => ({ agent: { threadId: 'thread-1', agentId: 'sales', messages, isRunning: running, addMessage } }),
  useCopilotKit: () => ({ copilotkit: { runAgent } }),
}));

vi.mock('@copilotkit/react-core/generative-ui', async (original) => ({
  ...(await original<typeof import('@copilotkit/react-core/generative-ui')>()),
  useGenerativeUIRuntime: () => ({ manager: { ingest, setActiveThread } }),
  // The engine's surface: here a button whose press CopilotKit dropped because the agent was answering.
  GenerativeUISurface: ({ id }: { id: string }) => <SurfaceStub id={id} />,
}));

function SurfaceStub({ id }: { id: string }) {
  const press = useBusyGuard((args: unknown) => Promise.resolve(pressed(args)));
  return (
    <div data-testid="surface">
      {id}
      <button type="button" onClick={() => void press?.({})}>
        Нажать
      </button>
    </div>
  );
}

const component = (id: string, text: string) => ({ id, component: 'Text', text });
// What CopilotKit answers a press while the agent is answering (use-generative-ui-root: «agent_busy»).
const BUSY = { ok: false as const, error: Object.assign(new Error('the agent is running'), { code: BUSY_CODE }) };
const SCREEN = [{ version: '1.0', createSurface: { surfaceId: 'kp', dataModel: { seats: 15 }, components: [{ id: 'root', component: 'Column', children: ['a', 'b'] }, component('a', 'Первый'), component('b', 'Второй')] } }];

beforeEach(() => {
  messages = [];
  running = false;
  pressed.mockClear();
  addMessage.mockClear();
  runAgent.mockClear();
});
afterEach(() => {
  ingest.mockClear();
  setActiveThread.mockClear();
});

describe('the set of widgets', () => {
  it('holds the approved components under our catalog, with CopilotKit’s props', () => {
    expect(widgetsUI.id).toBe(WIDGET_CATALOG_ID);
    expect(Object.keys(widgetsUI.manifestComponents).sort()).toEqual([...WIDGET_COMPONENTS].sort());
    // Our components draw the same props the agent writes: the descriptions are CopilotKit's own.
    for (const name of WIDGET_COMPONENTS) expect(widgetsUI.manifestComponents[name], name).toEqual(standardUI.manifestComponents[name]);
  });
});

describe('the operations of a call', () => {
  it('give one component per operation under the surface of the call', () => {
    const drawn = drawableOperations({ operations: SCREEN }, 'call-1', true);
    expect(drawn.written).toBe('kp');
    expect(drawn.surfaceId).toBe('kp@call-1');
    expect(drawn.ops).toEqual([
      { version: '1.0', createSurface: { surfaceId: 'kp@call-1', dataModel: { seats: 15 }, components: [{ id: 'root', component: 'Column', children: ['a', 'b'] }] } },
      { version: '1.0', updateComponents: { surfaceId: 'kp@call-1', components: [component('a', 'Первый')] } },
      { version: '1.0', updateComponents: { surfaceId: 'kp@call-1', components: [component('b', 'Второй')] } },
    ]);
  });

  it('while the call is written, wait for the last component, and read a list written as a string without versions', () => {
    const streaming = drawableOperations({ operations: SCREEN }, 'call-1', false);
    expect(streaming.ops).toHaveLength(2);
    const unmarked = SCREEN.map(({ version: _version, ...op }) => op);
    expect(drawableOperations({ operations: JSON.stringify(unmarked) }, 'call-1', true).ops).toHaveLength(3);
    // A call that only changes a screen drawn above draws nothing of its own.
    expect(drawableOperations({ operations: [{ version: '1.0', updateDataModel: { surfaceId: 'kp', path: '/seats', value: 3 } }] }, 'call-2', true).written).toBeNull();
  });

  // Review 20.11: «createSurface» with its data and no component, the components after it — as CopilotKit's guide
  // allows; CopilotKit wants a component in createSurface, and the data went missing with it.
  it('keep the data of a screen whose components come after its createSurface', () => {
    const ops = [
      { version: '1.0', createSurface: { surfaceId: 'kp', dataModel: { seats: 15 } } },
      { version: '1.0', updateDataModel: { surfaceId: 'kp', path: '/seats', value: 20 } },
      { version: '1.0', updateComponents: { surfaceId: 'kp', components: [{ id: 'root', component: 'Column', children: ['a'] }, component('a', 'Первый')] } },
    ];
    expect(drawableOperations({ operations: ops }, 'call-1', true).ops).toEqual([
      { version: '1.0', createSurface: { surfaceId: 'kp@call-1', dataModel: { seats: 15 }, components: [{ id: 'root', component: 'Column', children: ['a'] }] } },
      { version: '1.0', updateDataModel: { surfaceId: 'kp@call-1', path: '/seats', value: 20 } },
      { version: '1.0', updateComponents: { surfaceId: 'kp@call-1', components: [component('a', 'Первый')] } },
    ]);
  });

  // The data written after the components may be cut while the call is written, and CopilotKit does not apply the
  // first operation again: the screen waits for its data.
  it('draw nothing of a screen whose data is still being written after its components', () => {
    const late = [{ version: '1.0', createSurface: { surfaceId: 'kp', components: [{ id: 'root', component: 'Column', children: ['a'] }, component('a', 'Первый')], dataModel: { seats: 2 } } }];
    expect(drawableOperations({ operations: late }, 'call-1', false).ops).toEqual([]);
    expect(drawableOperations({ operations: late }, 'call-1', true).ops).toHaveLength(2);
  });

  it('take the changes later calls of the answer made, shown ones only, up to the next screen of the name', () => {
    const call = (id: string, operations: unknown) => ({ role: 'assistant', toolCalls: [{ id, function: { name: 'render_ui', arguments: JSON.stringify({ operations }) } }] });
    const result = (id: string, content: unknown) => ({ role: 'tool', toolCallId: id, content: JSON.stringify(content) });
    const change = (value: number) => [{ version: '1.0', updateDataModel: { surfaceId: 'kp', path: '/seats', value } }];
    const all = [
      call('c1', SCREEN),
      result('c1', { shown: true, surfaceId: 'kp' }),
      call('c2', change(20)),
      result('c2', { shown: true, surfaceId: 'kp' }),
      call('c3', change(30)),
      result('c3', { error: true, code: 'APP_WIDGET_INVALID', message: 'нет' }),
      call('c4', SCREEN),
      result('c4', { shown: true, surfaceId: 'kp' }),
      call('c5', change(40)),
      result('c5', { shown: true, surfaceId: 'kp' }),
    ];
    expect(laterChanges(all, 'c1', 'kp', 'kp@c1')).toEqual([{ version: '1.0', updateDataModel: { surfaceId: 'kp@c1', path: '/seats', value: 20 } }]);
    expect(laterChanges(all, 'c4', 'kp', 'kp@c4')).toEqual([{ version: '1.0', updateDataModel: { surfaceId: 'kp@c4', path: '/seats', value: 40 } }]);
    // Review 20.11: a screen of the same name the server refused is not a new screen — the change after it is this one's.
    const afterRefused = [
      call('c1', SCREEN),
      result('c1', { shown: true, surfaceId: 'kp' }),
      call('c2', SCREEN),
      result('c2', { error: true, code: 'APP_WIDGET_INVALID', message: 'уже показан' }),
      call('c3', change(25)),
      result('c3', { shown: true, surfaceId: 'kp' }),
    ];
    expect(laterChanges(afterRefused, 'c1', 'kp', 'kp@c1')).toEqual([{ version: '1.0', updateDataModel: { surfaceId: 'kp@c1', path: '/seats', value: 25 } }]);
  });
});

// Our components hand a press to CopilotKit's engine, which sends the person's message with the label and the values.
describe('our components of the mockup', () => {
  const draw = (name: keyof typeof widgetOverrides, props: Record<string, unknown>) => {
    const Drawn = widgetOverrides[name].component as unknown as (props: Record<string, unknown>) => ReactNode;
    return render(<Drawn {...props} />);
  };

  it('pass the press of a button on glass and of an action of the recommended card', async () => {
    const onClick = vi.fn();
    const Card = widgetOverrides.Card.component as unknown as (props: Record<string, unknown>) => ReactNode;
    const Button = widgetOverrides.Button.component as unknown as (props: Record<string, unknown>) => ReactNode;
    render(<Card background="discovery-solid" child={<Button label="Оформить КП" variant="primary" onClick={onClick} />} />);
    await userEvent.click(screen.getByRole('button', { name: 'Оформить КП' }));
    expect(onClick).toHaveBeenCalledOnce();

    const onAction = vi.fn();
    draw('EntityCard', { title: 'Тариф «Бизнес»', badge: { label: 'Рекомендуем', color: 'discovery' }, actions: [{ label: 'Выбрать' }, { label: 'Сравнить' }], onAction });
    await userEvent.click(screen.getByRole('button', { name: 'Сравнить' }));
    expect(onAction).toHaveBeenCalledWith({ label: 'Сравнить' });
  });

  // e2e 20.11: a button pressed while the agent was still writing did nothing at all.
  it('tell the block when CopilotKit drops a press because the agent is answering', async () => {
    const report = vi.fn();
    const busy = () => Promise.resolve(BUSY);
    const Card = widgetOverrides.Card.component as unknown as (props: Record<string, unknown>) => ReactNode;
    const Button = widgetOverrides.Button.component as unknown as (props: Record<string, unknown>) => ReactNode;
    const Form = widgetOverrides.Form.component as unknown as (props: Record<string, unknown>) => ReactNode;
    const EntityCard = widgetOverrides.EntityCard.component as unknown as (props: Record<string, unknown>) => ReactNode;
    render(
      <BusyPress.Provider value={report}>
        <Button label="Обычная" onClick={busy} />
        <Card background="discovery-solid" child={<Button label="На стекле" variant="primary" onClick={busy} />} />
        <Form onSubmit={busy}>{<Button label="Отправить форму" submit />}</Form>
        <EntityCard title="Тариф" badge={{ label: 'Рекомендуем', color: 'discovery' }} actions={[{ label: 'Выбрать' }]} onAction={busy} />
      </BusyPress.Provider>,
    );
    for (const name of ['Обычная', 'На стекле', 'Отправить форму', 'Выбрать']) await userEvent.click(screen.getByRole('button', { name }));
    expect(report).toHaveBeenCalledTimes(4);
  });

  // Review 20.11: the second click of a double click came back «busy» from the run the first one started.
  it('do not send a press again while its first one is still going', async () => {
    let finish = () => undefined as void;
    const onClick = vi.fn(() => new Promise<{ ok: true; result: undefined }>((resolve) => (finish = () => resolve({ ok: true, result: undefined }))));
    const Button = widgetOverrides.Button.component as unknown as (props: Record<string, unknown>) => ReactNode;
    render(<Button label="Оформить КП" onClick={onClick} />);
    await userEvent.dblClick(screen.getByRole('button', { name: 'Оформить КП' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(onClick).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Оформить КП' }));
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  // Review 20.11 (decision of the owner 19.11, F36): a picture of another site in a widget is a link, as in answers.
  it('show the pictures of other sites in Markdown and on a card as links', () => {
    draw('Markdown', { text: 'Схема: ![склад](https://example.com/plan.png)' });
    expect(screen.getByRole('link', { name: /example\.com\/plan\.png/ })).toHaveAttribute('href', 'https://example.com/plan.png');
    draw('EntityCard', { title: 'Склад Северный', image: 'https://example.com/sklad.jpg' });
    expect(screen.getByRole('link', { name: 'Картинка: example.com/sklad.jpg' })).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('give a glass button only an address of the web or of mail, and only copy with «copy»', async () => {
    const onClick = vi.fn();
    const Card = widgetOverrides.Card.component as unknown as (props: Record<string, unknown>) => ReactNode;
    const Button = widgetOverrides.Button.component as unknown as (props: Record<string, unknown>) => ReactNode;
    render(
      <Card
        background="discovery-solid"
        children={[<Button key="a" label="Сайт" href="javascript:alert(1)" onClick={onClick} />, <Button key="b" label="Почта" href="mailto:sales@example.com" />, <Button key="c" label="Скопировать" copy="ИНН 5406012345" onClick={onClick} />]}
      />,
    );
    expect(screen.queryByRole('link', { name: 'Сайт' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Почта' })).toHaveAttribute('href', 'mailto:sales@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Скопировать' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  // Owner 20.11 («выбранные кнопки никак не помечаются»), as a choice of the chat (16.11): the control that sent the
  // answer is marked by colour and a tick, the others that send are inactive; what works in place keeps working.
  it('mark the button that sent the answer and make the others that send inactive', () => {
    const Button = widgetOverrides.Button.component as unknown as (props: Record<string, unknown>) => ReactNode;
    const onClick = vi.fn();
    render(
      <WidgetReplyContext.Provider value={{ answered: true, chosen: new Set(['Сравнить с планом']), sending: new Set(['Сравнить с планом', 'Разложить по менеджерам']) }}>
        <Button label="Сравнить с планом" onClick={onClick} />
        <Button label="Разложить по менеджерам" onClick={onClick} />
        <Button label="Открыть сайт" href="https://example.com" />
      </WidgetReplyContext.Provider>,
    );
    const chosen = screen.getByRole('button', { name: 'Сравнить с планом, выбрано' });
    expect(chosen).toHaveAttribute('data-chosen', 'true');
    expect(chosen).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Разложить по менеджерам' })).toBeDisabled();
    // A link opens what it opens: it sends no message.
    expect(screen.getByRole('button', { name: 'Открыть сайт' })).toBeEnabled();
  });

  it('send a follow-up as the person’s message, then mark it and make the pills inactive', async () => {
    const FollowUp = widgetOverrides.FollowUp.component as unknown as (props: Record<string, unknown>) => ReactNode;
    const items = ['Сравнить с планом', { label: 'Сделать слайд', message: 'Сделай слайд для отчёта' }];
    const view = render(<FollowUp items={items} />);
    await userEvent.click(screen.getByRole('button', { name: 'Сделать слайд' }));
    expect(addMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', content: 'Сделай слайд для отчёта' }));
    expect(runAgent).toHaveBeenCalledOnce();
    view.rerender(
      <WidgetReplyContext.Provider value={{ answered: true, chosen: new Set(['Сделать слайд']), sending: new Set(['Сравнить с планом', 'Сделать слайд']) }}>
        <FollowUp items={items} />
      </WidgetReplyContext.Provider>,
    );
    expect(screen.getByRole('button', { name: 'Сделать слайд, выбрано' })).toHaveAttribute('data-chosen', 'true');
    expect(screen.getByRole('button', { name: 'Сравнить с планом' })).toBeDisabled();
  });

  it('do not send a follow-up while the agent answers, and say so', async () => {
    running = true;
    const report = vi.fn();
    const FollowUp = widgetOverrides.FollowUp.component as unknown as (props: Record<string, unknown>) => ReactNode;
    render(
      <BusyPress.Provider value={report}>
        <FollowUp items={['Сравнить с планом']} />
      </BusyPress.Provider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Сравнить с планом' }));
    expect(addMessage).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledOnce();
  });

  it('draw a card of the mockup: a plan with its price, a client in a row with its letters, the chosen action marked', () => {
    draw('EntityCard', { title: 'Команда', subtitle: 'до 30 сотрудников', meta: '2 900 ₽ / мес', description: 'CRM и почта', badge: { label: 'Хит', color: 'success' }, actions: [{ label: 'Выбрать' }], onAction: vi.fn() });
    expect(screen.getByText('2 900 ₽ / мес')).toBeInTheDocument();
    expect(screen.getByText('Хит')).toBeInTheDocument();
    draw('EntityCard', { title: 'ООО «Стройресурс»', layout: 'horizontal' });
    expect(screen.getByText('С')).toBeInTheDocument();
    const Card = widgetOverrides.EntityCard.component as unknown as (props: Record<string, unknown>) => ReactNode;
    render(
      <WidgetReplyContext.Provider value={{ answered: true, chosen: new Set(['Выбрать']), sending: new Set(['Выбрать', 'Сравнить']) }}>
        <Card title="Старт" actions={[{ label: 'Выбрать' }, { label: 'Сравнить' }]} onAction={vi.fn()} />
      </WidgetReplyContext.Provider>,
    );
    expect(screen.getByRole('button', { name: 'Выбрать, выбрано' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Сравнить' })).toBeDisabled();
  });

  // Review 20.11: with the submit button marked the form was left open to Enter in its field — a second message.
  it('send nothing from an answered form, not by Enter either', async () => {
    const onSubmit = vi.fn(() => Promise.resolve({ ok: true as const, result: undefined }));
    const Form = widgetOverrides.Form.component as unknown as (props: Record<string, unknown>) => ReactNode;
    const Button = widgetOverrides.Button.component as unknown as (props: Record<string, unknown>) => ReactNode;
    render(
      <WidgetReplyContext.Provider value={{ answered: true, chosen: new Set(['Отправить']), sending: new Set(['Отправить']) }}>
        <Form onSubmit={onSubmit}>
          <input aria-label="Клиент" />
          <Button label="Отправить" submit />
        </Form>
      </WidgetReplyContext.Provider>,
    );
    expect(screen.getByRole('button', { name: 'Отправить, выбрано' })).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Клиент' }), 'ООО Сибирь{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // The answer cannot tell three «Выбрать» apart; this window knows which one was pressed.
  it('mark the button pressed in this window though another sends the same words', async () => {
    const Button = widgetOverrides.Button.component as unknown as (props: Record<string, unknown>) => ReactNode;
    const onClick = vi.fn(() => Promise.resolve({ ok: true as const, result: undefined }));
    const tree = (answered: boolean) => (
      <WidgetReplyContext.Provider value={{ answered, chosen: new Set(), sending: new Set(['Выбрать']) }}>
        <Button label="Выбрать" onClick={onClick} />
        <Button label="Выбрать" onClick={onClick} />
      </WidgetReplyContext.Provider>
    );
    const view = render(tree(false));
    await userEvent.click(screen.getAllByRole('button', { name: 'Выбрать' })[1]!);
    view.rerender(tree(true));
    expect(screen.getByRole('button', { name: 'Выбрать, выбрано' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Выбрать' })).toBeDisabled();
  });

  it('show a picture of another site as a link to open', () => {
    draw('Image', { url: 'https://example.com/photo.png' });
    expect(screen.getByRole('link', { name: 'Картинка: example.com/photo.png' })).toHaveAttribute('href', 'https://example.com/photo.png');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('the answer to a widget', () => {
  const screen1 = (components: Record<string, unknown>[], surfaceId = 'kp') => [{ version: '1.0', createSurface: { surfaceId, components: [{ id: 'root', component: 'Column', children: components.map((c) => c.id) }, ...components] } }];
  const press = (name: string, userMessage?: string) => ({ event: { name, ...(userMessage ? { userMessage } : {}) } });

  it('knows the controls that send: buttons with an event, submit buttons of a form, actions of a card, follow-ups', () => {
    const ops = screen1([
      { id: 'plan', component: 'Button', label: 'Сравнить с планом', onClick: press('plan', 'Сравни с планом') },
      { id: 'site', component: 'Button', label: 'Открыть сайт', onClick: { functionCall: { call: 'openUrl', args: { url: 'https://example.com' } } } },
      { id: 'form', component: 'Form', children: ['send'], onSubmit: press('submit', 'Заявка') },
      { id: 'send', component: 'Button', label: 'Отправить заявку', submit: true },
      { id: 'card', component: 'EntityCard', title: 'Старт', actions: [{ label: 'Выбрать' }, { label: 'Сайт', href: 'https://example.com' }], onAction: press('pick') },
      { id: 'fu', component: 'FollowUp', items: ['Ещё', { label: 'Слайд', message: 'Сделай слайд' }] },
    ]);
    expect(sendingControls(ops).map((c) => [c.words, c.head])).toEqual([
      ['Сравнить с планом', 'Сравни с планом'],
      ['Отправить заявку', 'Заявка'],
      ['Выбрать', 'Выбрать'],
      ['Ещё', 'Ещё'],
      ['Слайд', 'Сделай слайд'],
    ]);
    expect(replyHead('Заявка\n\ninn: 5406012345')).toBe('Заявка');
    expect([...widgetReply(ops, [ops], 'Сравни с планом').chosen]).toEqual(['Сравнить с планом']);
    expect([...widgetReply(ops, [ops], 'Заявка\n\ninn: 5406012345').chosen]).toEqual(['Отправить заявку']);
    expect(widgetReply(ops, [ops], 'Что-то своё')).toMatchObject({ answered: true, chosen: new Set() });
    expect(widgetReply(ops, [ops], null)).toMatchObject({ answered: false });
  });

  // Review 20.11: three plan cards each with «Выбрать» send the same message — the answer cannot tell which was pressed.
  it('marks nothing by the answer when several controls of the answer send the same words', () => {
    const card = (id: string) => ({ id, component: 'EntityCard', title: id, actions: [{ label: 'Выбрать' }], onAction: press('pick') });
    const plans = screen1([card('Старт'), card('Команда'), card('Предприятие')]);
    expect(widgetReply(plans, [plans], 'Выбрать').chosen.size).toBe(0);
    const a = screen1([{ id: 'go', component: 'Button', label: 'Да', onClick: press('a') }], 'a');
    const b = screen1([{ id: 'go', component: 'Button', label: 'Да', onClick: press('b') }], 'b');
    expect(widgetReply(a, [a, b], 'Да').chosen.size).toBe(0);
    // A change of the same screen in place sends the same button again: it is still one.
    const changed = [{ version: '1.0', updateComponents: { surfaceId: 'a', components: [{ id: 'go', component: 'Button', label: 'Да', onClick: press('a') }] } }];
    expect([...widgetReply(a, [a, changed], 'Да').chosen]).toEqual(['Да']);
  });

  it('takes the screens of the answer the call is in, shown ones only', () => {
    const call = (id: string, operations: unknown) => ({ id: `m-${id}`, role: 'assistant', toolCalls: [{ id, type: 'function', function: { name: 'render_ui', arguments: JSON.stringify({ operations }) } }] });
    const result = (id: string, content: unknown) => ({ id: `r-${id}`, role: 'tool', toolCallId: id, content: JSON.stringify(content) });
    const a = screen1([{ id: 'go', component: 'Text', text: 'А' }], 'a');
    const messages = [
      { id: 'u1', role: 'user', content: 'Покажи' },
      call('c1', a),
      result('c1', { shown: true, surfaceId: 'a' }),
      call('c2', a),
      result('c2', { error: true, code: 'APP_WIDGET_INVALID', message: 'нет' }),
      { id: 'u2', role: 'user', content: 'Дальше' },
      call('c3', a),
      result('c3', { shown: true, surfaceId: 'a' }),
    ] as never;
    expect(screensOfAnswer(messages, 'c1')).toHaveLength(1);
    expect(screensOfAnswer(messages, 'c3')).toHaveLength(1);
  });
});

describe('the line of the descriptions of components', () => {
  const agent = { systems: { tools: {}, prefixes: {} }, actions: {} };

  it('says the agent picks the elements, then how many it took', () => {
    expect(toolSummary(WIDGET_TOOL.components, 'executing', undefined, agent, { names: ['Card'] })).toMatchObject({ state: 'running', text: 'Подбираю элементы виджета…' });
    expect(toolSummary(WIDGET_TOOL.components, 'complete', JSON.stringify({ guide: '…' }), agent, { names: ['Card', 'Table', 'Button'] })).toMatchObject({ state: 'done', text: 'Подобраны элементы виджета: 3' });
    expect(toolSummary(WIDGET_TOOL.components, 'complete', JSON.stringify({ error: true, code: 'APP_WIDGET_UNKNOWN_COMPONENT', message: 'нет' }), agent, { names: ['Foo'] })).toMatchObject({ state: 'failed', code: 'APP_WIDGET_UNKNOWN_COMPONENT' });
  });
});

// What the line of a done widget or file says in the stack (decision of the owner 21.11: every done action goes there).
describe('the lines of the screens and files the agent showed', () => {
  const agent = { systems: { tools: {}, prefixes: {} }, actions: {} };
  const shown = JSON.stringify({ shown: true, surfaceId: 'kp', note: '…' });

  it('says the widget was made, changed or not let through the check', () => {
    expect(toolSummary(WIDGET_TOOL.render, 'complete', shown, agent, { operations: SCREEN })).toMatchObject({ state: 'done', text: 'Виджет собран', readOnly: false });
    const change = { operations: [{ version: '1.0', updateDataModel: { surfaceId: 'kp', path: '/seats', value: 3 } }] };
    expect(toolSummary(WIDGET_TOOL.render, 'complete', shown, agent, change)).toMatchObject({ state: 'done', text: 'Виджет изменён' });
    const refused = JSON.stringify({ error: true, code: 'APP_WIDGET_INVALID', message: 'Экран не собран' });
    expect(toolSummary(WIDGET_TOOL.render, 'complete', refused, agent, { operations: SCREEN })).toEqual({ state: 'failed', text: 'Виджет не прошёл проверку', code: 'APP_WIDGET_INVALID' });
  });

  it('says which file was shown, or that it was not', () => {
    expect(toolSummary(GENUI_TOOL.file, 'complete', JSON.stringify({ shown: true, path: 'итоги/КП.docx', name: 'КП.docx', bytes: 10 }), agent, { path: 'итоги/КП.docx' })).toMatchObject({ state: 'done', text: 'Показан файл «КП.docx»' });
    expect(toolSummary(GENUI_TOOL.file, 'complete', JSON.stringify({ shown: false, error: 'Файла «нет.docx» нет в рабочей папке.' }), agent, { path: 'нет.docx' })).toEqual({ state: 'failed', text: 'Не получилось показать файл', code: null });
  });
});

describe('the block of a widget', () => {
  const show = (call: { status: 'inProgress' | 'executing' | 'complete'; result?: string; parameters?: unknown }, turn: TurnState) =>
    render(
      <TurnStateContext.Provider value={turn}>
        <WidgetCall call={{ toolCallId: 'call-1', parameters: call.parameters ?? { operations: SCREEN }, status: call.status, result: call.result }} />
      </TurnStateContext.Provider>,
    );

  it('gives the screen to CopilotKit’s engine under its own place, and draws it there', () => {
    show({ status: 'complete', result: JSON.stringify({ shown: true, surfaceId: 'kp' }) }, 'ended');
    expect(setActiveThread).toHaveBeenCalledWith('thread-1');
    expect(ingest).toHaveBeenCalledWith('thread-1', 'sales', expect.objectContaining({ surfaceId: 'kp@call-1', target: 'w-call-1', catalogId: WIDGET_CATALOG_ID, status: 'ready' }));
    expect(screen.getByTestId('surface')).toHaveTextContent('w-call-1');
  });

  it('draws while the agent writes the call', () => {
    show({ status: 'inProgress' }, 'answering');
    expect(ingest).toHaveBeenCalledWith('thread-1', 'sales', expect.objectContaining({ status: 'streaming' }));
  });

  it('draws nothing for a refused call — no status the agent may not live up to (owner, 20.11)', () => {
    const refused = JSON.stringify({ error: true, code: 'APP_WIDGET_INVALID', message: 'Экран не собран' });
    const answering = show({ status: 'complete', result: refused }, 'answering');
    expect(answering.container).toBeEmptyDOMElement();
    answering.unmount();
    const { container } = show({ status: 'complete', result: refused }, 'ended');
    expect(container).toBeEmptyDOMElement();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('says the screen was not finished when the answer stopped in the middle of it', () => {
    show({ status: 'executing' }, 'ended');
    expect(screen.getByText('Экран не дорисован — ответ прерван')).toBeInTheDocument();
  });

  // e2e 20.11: a press while the agent still wrote its answer did nothing at all. It is not sent later by itself: that
  // would cancel a «Да» question the answer ends with, and go after «Стоп» (review 20.11).
  it('says to press again when the answer is done, and sends nothing by itself', async () => {
    running = true;
    const view = show({ status: 'complete', result: JSON.stringify({ shown: true, surfaceId: 'kp' }) }, 'answering');
    await userEvent.click(screen.getByRole('button', { name: 'Нажать' }));
    expect(screen.getByRole('status')).toHaveTextContent('Агент ещё отвечает — нажмите ещё раз, когда он закончит');
    running = false;
    view.rerender(
      <TurnStateContext.Provider value="ended">
        <WidgetCall call={{ toolCallId: 'call-1', parameters: { operations: SCREEN }, status: 'complete', result: JSON.stringify({ shown: true, surfaceId: 'kp' }) }} />
      </TurnStateContext.Provider>,
    );
    expect(screen.queryByText(/Агент ещё отвечает/)).not.toBeInTheDocument();
    expect(pressed).toHaveBeenCalledTimes(1);
  });

  // 21.11: «Готовлю…» turned under the answer while «Работаю» turned below it. Until its first component the live
  // line of the answer says the widget is being written (decision of the owner 21.11).
  it('draws no placeholder of its own while no component is written yet', () => {
    const { container } = show({ status: 'inProgress', parameters: { operations: [{ version: '1.0', createSurface: { surfaceId: 'kp' } }] } }, 'answering');
    expect(container).toBeEmptyDOMElement();
    expect(ingest).not.toHaveBeenCalled();
    expect(toolSummary(WIDGET_TOOL.render, 'inProgress', undefined, { systems: { tools: {}, prefixes: {} }, actions: {} })).toEqual({ state: 'running', text: 'Собираю виджет…' });
  });

  // Review 20.11: a change of a screen above, while it is written, showed «Готовлю…» under the screen for nothing.
  it('draws nothing while a call that changes a screen above is written', () => {
    const { container } = show({ status: 'inProgress', parameters: { operations: [{ version: '1.0', updateDataModel: { surfaceId: 'kp', path: '/seats' } }] } }, 'answering');
    expect(container).toBeEmptyDOMElement();
  });

  it('draws nothing for a call that only changed a screen above it', () => {
    const { container } = show({ status: 'complete', result: JSON.stringify({ shown: true, surfaceId: 'kp' }), parameters: { operations: [{ version: '1.0', updateDataModel: { surfaceId: 'kp', path: '/seats', value: 3 } }] } }, 'ended');
    expect(container).toBeEmptyDOMElement();
  });
});
