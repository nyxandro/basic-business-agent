// Where the chat stream announces the messages of a broken model call (spec, section 9.1): right
// before the first event that is no longer about them, never ahead of their own words.
import { CHAT_EVENTS } from '@bba/contracts';
import { describe, expect, it } from 'vitest';
import { createDiscardTracker } from './discards.ts';

const line = (event: object) => `data: ${JSON.stringify(event)}`;
const text = (messageId: string, delta: string) => line({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta });
const discard = (messageId: string) => line({ type: 'CUSTOM', name: CHAT_EVENTS.messageDiscarded, value: { messageId } });

// Feeds the lines through a tracker; `drop` marks where the retry processor reports a broken call.
function stream(items: (string | { drop: string })[]): string[] {
  const reported: string[] = [];
  const tracker = createDiscardTracker(() => reported.splice(0));
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') out.push(...tracker.pass(item).split('\n').filter(Boolean));
    else reported.push(item.drop);
  }
  out.push(...tracker.rest().split('\n').filter(Boolean));
  return out;
}

describe('announcing dropped messages', () => {
  it('goes after the dropped words and right before the new answer', () => {
    expect(stream([text('m1', 'Пр'), { drop: 'm1' }, text('m2', 'Привет')])).toEqual([text('m1', 'Пр'), discard('m1'), text('m2', 'Привет')]);
  });

  it('waits for words of the dropped message still ahead in the stream when the break is reported early', () => {
    const end = line({ type: 'TEXT_MESSAGE_END', messageId: 'm1' });
    expect(stream([{ drop: 'm1' }, text('m1', 'Пр'), end, text('m2', 'Привет')])).toEqual([text('m1', 'Пр'), end, discard('m1'), text('m2', 'Привет')]);
  });

  it('drops only the broken step: the action of an earlier step under the same response stays', () => {
    const call = line({ type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'crm_search', parentMessageId: 'm1' });
    const result = line({ type: 'TOOL_CALL_RESULT', messageId: 'r1', toolCallId: 'c1', content: '{}', role: 'tool' });
    const out = stream([call, result, text('m1-agui-text', 'Сделок 12. Пр'), { drop: 'm1' }, text('m2', 'Сделок 12.')]);
    expect(out).toEqual([call, result, text('m1-agui-text', 'Сделок 12. Пр'), discard('m1-agui-text'), text('m2', 'Сделок 12.')]);
  });

  it('is announced before the failure when the repeated call broke too', () => {
    const failed = line({ type: 'RUN_ERROR', code: 'APP_MODEL_UNAVAILABLE', message: 'Модель сейчас не отвечает.' });
    expect(stream([text('m1', 'Пр'), { drop: 'm1' }, failed])).toEqual([text('m1', 'Пр'), discard('m1'), failed]);
  });

  it('announces nothing when the broken call showed nothing', () => {
    expect(stream([{ drop: 'm1' }, text('m2', 'Привет')])).toEqual([text('m2', 'Привет')]);
  });

  it('announces at the end of the stream what nothing came after', () => {
    expect(stream([text('m1', 'Пр'), { drop: 'm1' }])).toEqual([text('m1', 'Пр'), discard('m1')]);
  });
});
