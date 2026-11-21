// How a turn of the agent is laid out (decision of the owner 15.11): the status lines between two
// things the agent shows go into one stack; its words and the blocks it draws stay in sight.
import { GENUI_TOOL, WEB_RESEARCH_TOOL, WIDGET_TOOL } from '@bba/contracts';
import type { AssistantMessage, Message } from '@copilotkit/react-core';
import { describe, expect, it } from 'vitest';
import { callsUnderWay } from './call-progress.ts';
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

  // A lone line is a stack of one: when the next call comes, the same line turns to it.
  it('makes a lone status line a stack of one', () => {
    expect(shape([said('a1', '', [call('c1')]), said('a2', 'Готово.')])).toEqual(['[c1]', 'Готово.']);
  });

  it('collects the calls of messages without words into one stack', () => {
    expect(shape([said('a1', '', [call('c1')]), said('a2', '', [call('c2')]), said('a3', '', [call('c3')])])).toEqual(['[c1 c2 c3]']);
  });

  it('leaves the blocks the agent draws in sight, and a table that came in a result', () => {
    const turn = [said('a1', '', [call('c1'), call('c2'), call('t1', GENUI_TOOL.table), call('c3'), call('c4'), call('crm', 'crm_search'), call('c5')])];
    const table = JSON.stringify({ table: { title: 'Сделки', columns: [{ key: 'deal', label: 'Сделка' }], rows: [{ deal: 'Поставка' }] } });
    expect(shape(turn, [result('crm', table)])).toEqual(['[c1 c2]', 't1', '[c3 c4]', 'crm', '[c5]']);
  });

  // The live block of a search is the search itself (spec, section 8.30), not a line of a stack.
  it('leaves the search of the internet in sight', () => {
    expect(shape([said('a1', '', [call('c1'), call('w1', WEB_RESEARCH_TOOL), call('c2')])])).toEqual(['[c1]', 'w1', '[c2]']);
  });

  // A widget is a screen the agent drew (spec, section 8.31); the descriptions of its components are a step of a stack.
  it('leaves a widget in sight and stacks the reading of its components', () => {
    expect(shape([said('a1', '', [call('d1', WIDGET_TOOL.components), call('u1', WIDGET_TOOL.render), call('c1')])])).toEqual(['[d1]', 'u1', '[c1]']);
  });

  it('puts nothing for a message with neither words nor calls', () => {
    expect(shape([said('a1', ''), said('a2', 'Привет!')])).toEqual(['Привет!']);
  });
});

// Decision of the owner 21.11: what the agent does now is said in one place — the live line under the answer, where
// «Работаю» stands; a call goes into the turn once it is done. An ended answer keeps every call («Ждёт», «Прервано»).
describe('the layout of the turn being answered now', () => {
  const live = (turn: AssistantMessage[], results: Message[] = []) => {
    const messages = [...turn, ...results];
    const underWay = new Set(callsUnderWay(messages).map((c) => c.id));
    return turnItems(turn, messages, underWay).map((item) => (item.kind === 'text' ? item.text : item.kind === 'call' ? item.call.id : `[${item.calls.map((c) => c.id).join(' ')}]`));
  };
  const written = (id: string, args: string) => ({ id, type: 'function' as const, function: { name: WIDGET_TOOL.render, arguments: args } });
  const FILE_SHOWN = '{"shown":true,"path":"КП.docx","name":"КП.docx","bytes":10}';
  const SCREEN_WHOLE = '{"operations":[{"version":"1.0","createSurface":{"surfaceId":"kp","components":[{"id":"root","component":"Text","text":"А"}]}}]}';
  const SCREEN = '{"operations":[{"version":"1.0","createSurface":{"surfaceId":"kp","dataModel":{},"components":[{"id":"root","component":"Column","children":["a"]},{"id":"a","component":"Text","text":"Первый"},';

  it('keeps a call under way out of its stack, and puts it in once it is done', () => {
    const turn = [said('a1', 'Смотрю папку.', [call('c1'), call('c2')])];
    expect(live(turn)).toEqual(['Смотрю папку.']);
    expect(live(turn, [result('c1', '{}')])).toEqual(['Смотрю папку.', '[c1]']);
    expect(live(turn, [result('c1', '{}'), result('c2', '{}')])).toEqual(['Смотрю папку.', '[c1 c2]']);
  });

  it('keeps the search and the file out while they are under way', () => {
    const turn = [said('a1', '', [call('w1', WEB_RESEARCH_TOOL), call('f1', GENUI_TOOL.file)])];
    expect(live(turn)).toEqual([]);
    expect(live(turn, [result('w1', '{"sources":[]}'), result('f1', FILE_SHOWN)])).toEqual(['w1', '[f1]', 'f1']);
  });

  // The engine draws a screen as the model writes it (spec, section 8.31): it is in sight from its first component.
  it('lets a widget in once it has something to draw', () => {
    expect(live([said('a1', '', [written('u1', '{"operations":[{"version":"1.0","createSurface":{"surfaceId":"kp",')])])).toEqual([]);
    expect(live([said('a1', '', [written('u1', SCREEN)])])).toEqual(['u1']);
  });

  // The adapter of Mastra puts a call of the next step on the message of the words before it, above the result of the
  // call before (core/chat/copilot.ts): the place of a call in the list says nothing of whether it is done.
  it('keeps the next call out though it stands above the result of the one before', () => {
    const turn = [said('a1', 'Соберу экран.', [call('d1', WIDGET_TOOL.components), written('u1', '{"operations":')])];
    expect(live(turn, [result('d1', '{"guide":"…"}')])).toEqual(['Соберу экран.', '[d1]']);
  });

  // Two calls of one step run side by side, and the later is done first: the stack it opens is the stack of both.
  it('keeps the stack the same one when an earlier call of it is done after a later one', () => {
    const turn = [said('a1', 'Смотрю.', [call('c1'), call('c2')])];
    const keyOf = (results: Message[]) => {
      const messages = [...turn, ...results];
      const stack = turnItems(turn, messages, new Set(callsUnderWay(messages).map((c) => c.id))).find((item) => item.kind === 'stack');
      return stack?.kind === 'stack' ? stack.key : null;
    };
    expect(keyOf([result('c2', '{}')])).toBe('c1');
    expect(keyOf([result('c2', '{}'), result('c1', '{}')])).toBe('c1');
  });

  // 21.11: the model wrote its screen four times before the check let it through, and the answer showed nothing above
  // «Собираю виджет…». Every done attempt is a line of the stack, the screen comes after its line.
  it('puts every attempt of a widget into the stack, and the screen after it', () => {
    const turn = [said('a1', '', [call('d1', WIDGET_TOOL.components), written('u1', SCREEN_WHOLE), written('u2', SCREEN_WHOLE), written('u3', '{"operations":')])];
    const refused = '{"error":true,"code":"APP_WIDGET_INVALID","message":"Экран не собран"}';
    expect(live(turn, [result('d1', '{"guide":"…"}'), result('u1', refused)])).toEqual(['[d1 u1]']);
    expect(live(turn, [result('d1', '{"guide":"…"}'), result('u1', refused), result('u2', '{"shown":true,"surfaceId":"kp","note":"…"}')])).toEqual(['[d1 u1 u2]', 'u2']);
  });

  it('gives a change of a screen above only its line, and a file its line before its block', () => {
    const change = written('u1', '{"operations":[{"version":"1.0","updateDataModel":{"surfaceId":"kp","path":"/seats","value":3}}]}');
    expect(live([said('a1', '', [change])], [result('u1', '{"shown":true,"surfaceId":"kp","note":"…"}')])).toEqual(['[u1]']);
    const files = [said('a1', '', [call('f1', GENUI_TOOL.file), call('f2', GENUI_TOOL.file)])];
    expect(live(files, [result('f1', '{"shown":false,"error":"Файла нет"}'), result('f2', FILE_SHOWN)])).toEqual(['[f1 f2]', 'f2']);
  });

  it('keeps every call of an answer that ended', () => {
    expect(shape([said('a1', '', [call('c1'), call('w1', WEB_RESEARCH_TOOL)])])).toEqual(['[c1]', 'w1']);
  });
});
