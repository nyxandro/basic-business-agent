// The name of the conversation in the stream of a chat run (spec, section 8.16): it goes in between
// events of the run, the end of the run waits for it only so long, and the words already there are
// never held back by that wait.
import { CHAT_EVENTS } from '@bba/contracts';
import { describe, expect, it } from 'vitest';
import { wrapRunResponse, type RunStreamHooks } from './stream.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const line = (event: object) => `data: ${JSON.stringify(event)}\n\n`;

// The stream of a run: each chunk arrives after its delay.
function runResponse(chunks: { text: string; afterMs?: number }[]): Response {
  let next = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = chunks[next++];
        if (!chunk) return controller.close();
        if (chunk.afterMs) await new Promise((resolve) => setTimeout(resolve, chunk.afterMs));
        controller.enqueue(encoder.encode(chunk.text));
      },
    }),
  );
}

const hooks = (title: RunStreamHooks['title']): RunStreamHooks => ({
  onEnd: () => undefined,
  translate: () => Promise.resolve({ code: 'APP_INTERNAL', message: 'Ошибка' }),
  afterStart: [],
  takeDiscarded: () => [],
  title,
});

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ type: string; name?: string; value?: unknown }[]> {
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)) as { type: string });
}

describe('the name in the stream of a run', () => {
  it('sends the last words at once and puts the name right before the end of the run when it comes', async () => {
    let give: (title: string | null) => void = () => undefined;
    const result = new Promise<string | null>((resolve) => (give = resolve));
    const res = wrapRunResponse(
      runResponse([{ text: line({ type: 'RUN_STARTED' }) + line({ type: 'TEXT_MESSAGE_CONTENT', delta: 'Готово.' }) + line({ type: 'RUN_FINISHED' }) }]),
      hooks({ threadId: 't1', result, waitAtEndMs: 5000 }),
    );
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain('Готово.');
    expect(first).not.toContain('RUN_FINISHED');

    give('Письмо клиентам о новых ценах');
    const rest = await readAll(reader);
    expect(rest.map((e) => e.type)).toEqual(['CUSTOM', 'RUN_FINISHED']);
    expect(rest[0]).toMatchObject({ name: CHAT_EVENTS.threadTitled, value: { threadId: 't1', title: 'Письмо клиентам о новых ценах' } });
  });

  it('never puts the name before the start or after the end of the run', async () => {
    const res = wrapRunResponse(
      runResponse([
        { text: line({ type: 'RUN_STARTED' }) + line({ type: 'RUN_FINISHED' }) },
        // Anything after the end of the run, once the name is known.
        { text: line({ type: 'CUSTOM', name: 'other', value: null }), afterMs: 80 },
      ]),
      hooks({ threadId: 't1', result: new Promise((resolve) => setTimeout(() => resolve('Поздно'), 30)), waitAtEndMs: 0 }),
    );
    const events = await readAll((res.body as ReadableStream<Uint8Array>).getReader());
    expect(events.map((e) => e.name ?? e.type)).toEqual(['RUN_STARTED', 'RUN_FINISHED', 'other']);
  });
});
