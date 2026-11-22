// A list the person picks from (spec, section 8.31; issue #23): a pick while the agent is still answering is not lost
// silently, a double pick is one message, and once the person answered the items that send are inactive and the picked
// one is marked, as with buttons. Select, ChoicePicker and Tabs of CopilotKit 2.0.0-rc.49 have no event at all — they
// change their value in place, so only List and ListItem send.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BUSY_CODE, BusyPress } from './busy.tsx';
import { widgetOverrides } from './overrides.tsx';
import { sendingControls, WidgetReplyContext, widgetReply, type WidgetReply } from './reply.ts';

const BUSY = { ok: false as const, error: Object.assign(new Error('the agent is running'), { code: BUSY_CODE }) };
const SENT = { ok: true as const, result: undefined };
const List = widgetOverrides.List.component as unknown as (props: Record<string, unknown>) => ReactNode;
const ListItem = widgetOverrides.ListItem.component as unknown as (props: Record<string, unknown>) => ReactNode;
const PLANS = [{ label: 'Тариф Старт', value: 'start' }, { label: 'Тариф Бизнес', value: 'business' }, 'Тариф Команда'];

const answered = (chosen: string[], sending: string[], sendsUnnamed = false): WidgetReply => ({ answered: true, chosen: new Set(chosen), sending: new Set(sending), sendsUnnamed });

describe('a list with a pick', () => {
  it('tells the block when CopilotKit drops a pick because the agent is answering', async () => {
    const report = vi.fn();
    const action = vi.fn(() => Promise.resolve(BUSY));
    render(
      <BusyPress.Provider value={report}>
        <List items={PLANS} action={action} />
        <ListItem label="Сделка ООО «Вектор»" action={action} />
      </BusyPress.Provider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Тариф Бизнес' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сделка ООО «Вектор»' }));
    expect(report).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenNthCalledWith(1, { index: 1, label: 'Тариф Бизнес', value: 'business' });
  });

  it('sends a double pick once', async () => {
    let finish = () => undefined as void;
    const action = vi.fn(() => new Promise<typeof SENT>((resolve) => (finish = () => resolve(SENT))));
    render(<List items={PLANS} action={action} />);
    await userEvent.dblClick(screen.getByRole('button', { name: 'Тариф Старт' }));
    expect(action).toHaveBeenCalledTimes(1);
    finish();
  });

  it('marks the item that sent the answer and makes the list inactive, without showing the hidden values', () => {
    const action = vi.fn();
    render(
      <WidgetReplyContext.Provider value={answered(['Тариф Бизнес'], ['Тариф Старт', 'Тариф Бизнес', 'Тариф Команда'])}>
        <List items={PLANS} action={action} />
      </WidgetReplyContext.Provider>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Тариф Бизнес').closest('[data-chosen]')).toHaveTextContent('Тариф Бизнес, выбрано');
    expect(screen.getByText('Тариф Старт').closest('[data-chosen]')).toBeNull();
    // With a pick the value is the payload of the pick, not shown (CopilotKit's List) — not after the answer either.
    expect(screen.queryByText('business')).not.toBeInTheDocument();
  });

  it('marks the item picked in this window though the answer cannot tell it', async () => {
    const action = vi.fn(() => Promise.resolve(SENT));
    const tree = (reply?: WidgetReply) => (
      <WidgetReplyContext.Provider value={reply ?? { answered: false, chosen: new Set(), sending: new Set(['Выбрать']), sendsUnnamed: false }}>
        <List items={['Выбрать', 'Выбрать']} action={action} />
      </WidgetReplyContext.Provider>
    );
    const view = render(tree());
    await userEvent.click(screen.getAllByRole('button', { name: 'Выбрать' })[1]!);
    view.rerender(tree(answered([], ['Выбрать'])));
    const items = screen.getAllByText('Выбрать');
    expect(items[0]!.closest('[data-chosen]')).toBeNull();
    expect(items[1]!.closest('[data-chosen]')).not.toBeNull();
  });

  it('greys the items of a list item by item out, and marks the picked one', () => {
    const action = vi.fn();
    render(
      <WidgetReplyContext.Provider value={answered(['Сделка ООО «Вектор»'], ['Сделка ООО «Вектор»', 'Сделка ООО «Сибирь»'])}>
        <ListItem label="Сделка ООО «Вектор»" value="d-1" action={action} />
        <ListItem label="Сделка ООО «Сибирь»" value="d-2" action={action} />
      </WidgetReplyContext.Provider>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Сделка ООО «Вектор»').closest('[data-chosen]')).toHaveTextContent('выбрано');
    expect(screen.getByText('Сделка ООО «Сибирь»').closest('[aria-disabled="true"]')).not.toBeNull();
    expect(screen.queryByText('d-2')).not.toBeInTheDocument();
  });

  it('greys out an item whose words come from the data once the list was answered', () => {
    const action = vi.fn(() => Promise.resolve(SENT));
    render(
      <WidgetReplyContext.Provider value={answered([], [], true)}>
        <ListItem label="Сделка ООО «Вектор»" action={action} />
      </WidgetReplyContext.Provider>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Сделка ООО «Вектор»').closest('[aria-disabled="true"]')).not.toBeNull();
  });

  it('keeps an item that only opens an address working after the answer, and a list without a pick as it was', async () => {
    const open = vi.fn(() => Promise.resolve(SENT));
    render(
      <WidgetReplyContext.Provider value={answered(['Сделка'], ['Сделка'])}>
        <ListItem label="Открыть сайт" action={open} />
        <List items={[{ label: 'Цена', value: '2 900 ₽' }]} />
      </WidgetReplyContext.Provider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Открыть сайт' }));
    expect(open).toHaveBeenCalledOnce();
    expect(screen.getByText('2 900 ₽')).toBeInTheDocument();
  });
});

describe('the answer to a list', () => {
  const screen1 = (components: Record<string, unknown>[]) => [{ version: '1.0', createSurface: { surfaceId: 'kp', components: [{ id: 'root', component: 'Column', children: components.map((c) => c.id) }, ...components] } }];
  const press = (userMessage?: string) => ({ event: { name: 'pick', ...(userMessage ? { userMessage } : {}) } });

  it('knows the items that send: a list with a pick, a list item with a pick, not one that opens an address', () => {
    const ops = screen1([
      { id: 'plans', component: 'List', items: ['Тариф Старт', { label: 'Тариф Бизнес', value: 'b' }], action: press() },
      { id: 'deal', component: 'ListItem', label: 'Сделка ООО «Вектор»', action: press('Открой сделку') },
      { id: 'site', component: 'ListItem', label: 'Сайт', action: { functionCall: { call: 'openUrl', args: { url: 'https://example.com' } } } },
      { id: 'fact', component: 'List', items: [{ label: 'Цена', value: '2 900 ₽' }] },
    ]);
    expect(sendingControls(ops).map((c) => [c.words, c.head])).toEqual([
      ['Тариф Старт', 'Тариф Старт'],
      ['Тариф Бизнес', 'Тариф Бизнес'],
      ['Сделка ООО «Вектор»', 'Открой сделку'],
    ]);
    // CopilotKit writes a pick of a list as the label of the item, then «index» and «value» lines.
    expect([...widgetReply(ops, [ops], 'Тариф Бизнес\n\nindex: 1\nvalue: b').chosen]).toEqual(['Тариф Бизнес']);
    expect(widgetReply(ops, [ops], 'Тариф Бизнес').sendsUnnamed).toBe(false);
  });

  it('says a list sends with words that come from the data', () => {
    const template = screen1([
      { id: 'deals', component: 'List', children: { componentId: 'deal', path: '/deals' } },
      { id: 'deal', component: 'ListItem', label: { '@path': 'name' }, action: press() },
    ]);
    expect(widgetReply(template, [template], null).sendsUnnamed).toBe(true);
    const bound = screen1([{ id: 'plans', component: 'List', items: { '@path': '/plans' }, action: press() }]);
    expect(widgetReply(bound, [bound], null).sendsUnnamed).toBe(true);
  });
});
