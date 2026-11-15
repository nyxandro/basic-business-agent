// The name a conversation got while the agent answered (spec, section 8.16).
import { CHAT_EVENTS } from '@bba/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { titleSubscriber } from './title-events.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const event = (name: string, value: unknown) => ({ event: { type: 'CUSTOM', name, value }, messages: [] });

describe('the name of the conversation in the chat stream', () => {
  it('loads «Недавние» again when this conversation got its name', () => {
    const onTitled = vi.fn();
    expect(titleSubscriber('t1', onTitled).onCustomEvent(event(CHAT_EVENTS.threadTitled, { threadId: 't1', title: 'Письмо клиентам о новых ценах' }))).toBeUndefined();
    expect(onTitled).toHaveBeenCalledTimes(1);
  });

  it('ignores another conversation, other events and a malformed one', () => {
    const onTitled = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const subscriber = titleSubscriber('t1', onTitled);
    subscriber.onCustomEvent(event(CHAT_EVENTS.threadTitled, { threadId: 't2', title: 'Чужой разговор' }));
    subscriber.onCustomEvent(event(CHAT_EVENTS.messageDiscarded, { messageId: 'a1' }));
    subscriber.onCustomEvent(event(CHAT_EVENTS.threadTitled, { threadId: 't1' }));
    expect(onTitled).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
