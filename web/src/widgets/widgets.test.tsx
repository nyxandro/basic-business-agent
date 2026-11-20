// Widgets in the chat (spec, section 8.31): the set of components is the approved one, the operations of a call reach
// CopilotKit's engine one component at a time under the call's own surface, a later call of the same answer changes the
// screen in place, and the block says what happened when there is no screen to show.
import { WIDGET_CATALOG_ID, WIDGET_COMPONENTS, WIDGET_TOOL } from '@bba/contracts';
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
import { WidgetCall } from './WidgetCall.tsx';

const ingest = vi.fn();
const setActiveThread = vi.fn();
let messages: unknown[] = [];
let running = false;
// The engine's answer to a press of the stub: «busy» while the agent answers, sent once it is done.
const pressed = vi.fn((_args: unknown) => (running ? BUSY : { ok: true as const, result: undefined }));

vi.mock('@copilotkit/react-core', async (original) => ({
  ...(await original<typeof import('@copilotkit/react-core')>()),
  useAgent: () => ({ agent: { threadId: 'thread-1', agentId: 'sales', messages, isRunning: running } }),
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

  it('show a picture of another site as a link to open', () => {
    draw('Image', { url: 'https://example.com/photo.png' });
    expect(screen.getByRole('link', { name: 'Картинка: example.com/photo.png' })).toHaveAttribute('href', 'https://example.com/photo.png');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
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

  it('says the screen is being rebuilt while the agent answers, and draws nothing after a refused call', () => {
    const refused = JSON.stringify({ error: true, code: 'APP_WIDGET_INVALID', message: 'Экран не собран' });
    const answering = show({ status: 'complete', result: refused }, 'answering');
    expect(screen.getByText('Собираю экран заново')).toBeInTheDocument();
    answering.unmount();
    const { container } = show({ status: 'complete', result: refused }, 'ended');
    expect(container).toBeEmptyDOMElement();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('says the screen was not finished when the answer stopped in the middle of it', () => {
    show({ status: 'executing' }, 'ended');
    expect(screen.getByText('Экран не дорисован — ответ прерван')).toBeInTheDocument();
  });

  // e2e 20.11: a press while the agent still wrote its answer did nothing; now it goes once the answer is done.
  it('sends a press the engine dropped while the agent answered, once the answer is done', async () => {
    running = true;
    const view = show({ status: 'complete', result: JSON.stringify({ shown: true, surfaceId: 'kp' }) }, 'answering');
    await userEvent.click(screen.getByRole('button', { name: 'Нажать' }));
    expect(screen.getByRole('status')).toHaveTextContent('Нажатие отправится, когда агент закончит ответ');
    expect(pressed).toHaveBeenCalledTimes(1);
    running = false;
    view.rerender(
      <TurnStateContext.Provider value="ended">
        <WidgetCall call={{ toolCallId: 'call-1', parameters: { operations: SCREEN }, status: 'complete', result: JSON.stringify({ shown: true, surfaceId: 'kp' }) }} />
      </TurnStateContext.Provider>,
    );
    await vi.waitFor(() => expect(pressed).toHaveBeenCalledTimes(2));
    expect(pressed).toHaveBeenLastCalledWith({});
    expect(screen.queryByText(/Нажатие отправится/)).not.toBeInTheDocument();
  });

  it('draws nothing for a call that only changed a screen above it', () => {
    const { container } = show({ status: 'complete', result: JSON.stringify({ shown: true, surfaceId: 'kp' }), parameters: { operations: [{ version: '1.0', updateDataModel: { surfaceId: 'kp', path: '/seats', value: 3 } }] } }, 'ended');
    expect(container).toBeEmptyDOMElement();
  });
});
