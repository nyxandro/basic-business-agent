// How a turn of the agent is laid out (decision of the owner 15.11): the status lines between two
// things the agent shows go into one stack; its words and the blocks it draws stay in sight.
import { GENUI_TOOL } from '@bba/contracts';
import type { AssistantMessage, Message } from '@copilotkit/react-core';
import { describe, expect, it } from 'vitest';
import { turnItems } from './turn-items.ts';

const call = (id: string, name = 'mastra_workspace_execute_command') => ({ id, type: 'function' as const, function: { name, arguments: '{}' } });
const said = (id: string, content: string, calls: ReturnType<typeof call>[] = []): AssistantMessage => ({ id, role: 'assistant', content, ...(calls.length ? { toolCalls: calls } : {}) });
const result = (toolCallId: string, content: string): Message => ({ id: `r-${toolCallId}`, role: 'tool', toolCallId, content });

// What a layout looks like, in short: «text», «c1» for a call on its own, «[c1 c2]» for a stack.
function shape(turn: AssistantMessage[], messages: Message[] = []): string[] {
  return turnItems(turn, messages).map((item) => (item.kind === 'text' ? item.text : item.kind === 'call' ? item.call.id : `[${item.calls.map((c) => c.id).join(' ')}]`));
}

describe('the layout of a turn', () => {
  it('stacks the status lines between the words of the agent; the words come before the calls of their message', () => {
    const turn = [said('a1', 'Смотрю папку.', [call('c1'), call('c2'), call('c3')]), said('a1-agui-text', 'Нашёл три файла. Читаю их.', [call('c4'), call('c5')]), said('a1-agui-text-2', 'Готово.')];
    expect(shape(turn)).toEqual(['Смотрю папку.', '[c1 c2 c3]', 'Нашёл три файла. Читаю их.', '[c4 c5]', 'Готово.']);
  });

  it('keeps a lone status line as it is', () => {
    expect(shape([said('a1', '', [call('c1')]), said('a2', 'Готово.')])).toEqual(['c1', 'Готово.']);
  });

  it('collects the calls of messages without words into one stack', () => {
    expect(shape([said('a1', '', [call('c1')]), said('a2', '', [call('c2')]), said('a3', '', [call('c3')])])).toEqual(['[c1 c2 c3]']);
  });

  it('leaves the blocks the agent draws in sight, and a table that came in a result', () => {
    const turn = [said('a1', '', [call('c1'), call('c2'), call('t1', GENUI_TOOL.table), call('c3'), call('c4'), call('crm', 'crm_search'), call('c5')])];
    const table = JSON.stringify({ table: { title: 'Сделки', columns: [{ key: 'deal', label: 'Сделка' }], rows: [{ deal: 'Поставка' }] } });
    expect(shape(turn, [result('crm', table)])).toEqual(['[c1 c2]', 't1', '[c3 c4]', 'crm', 'c5']);
  });

  it('puts nothing for a message with neither words nor calls', () => {
    expect(shape([said('a1', ''), said('a2', 'Привет!')])).toEqual(['Привет!']);
  });
});
