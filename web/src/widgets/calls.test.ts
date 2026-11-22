// The calls of `render_ui` are read once per list of messages for all the blocks of widgets (issue #26), and a call is
// parsed again only when its text changed — while the agent still writes it.
import { describe, expect, it } from 'vitest';
import { operationsOfCall, renderCallsOf, type HeldMessage } from './calls.ts';

const screen = (seats: number) => JSON.stringify({ operations: [{ version: '1.0', createSurface: { surfaceId: 'kp', components: [{ id: 'root', component: 'Text', text: `${seats}` }] } }] });

describe('the calls of a conversation', () => {
  it('are read once per list of messages, with the latest result of each', () => {
    const call = { id: 'c1', function: { name: 'render_ui', arguments: screen(1) } };
    const messages: HeldMessage[] = [
      { role: 'assistant', toolCalls: [call, { id: 'w1', function: { name: 'web_research', arguments: '{}' } }] },
      { role: 'tool', toolCallId: 'c1', content: JSON.stringify({ error: true }) },
      { role: 'tool', toolCallId: 'c1', content: JSON.stringify({ shown: true, surfaceId: 'kp' }) },
    ];
    const index = renderCallsOf(messages);
    expect(index.calls.map((c) => c.id)).toEqual(['c1']);
    expect([...index.shown]).toEqual(['c1']);
    expect(renderCallsOf(messages)).toBe(index);
    expect(renderCallsOf([...messages])).not.toBe(index);
  });

  it('parse a call again only when its text changed', () => {
    const call = { id: 'c1', function: { name: 'render_ui', arguments: screen(1) } };
    const first = operationsOfCall(call);
    expect(operationsOfCall(call)).toBe(first);
    call.function.arguments = screen(2);
    expect(JSON.stringify(operationsOfCall(call))).toContain('"2"');
  });
});
