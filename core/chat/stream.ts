// Wraps the AG-UI event stream of a chat run: releases the conversation when the stream ends
// (normally or because the browser left), turns raw run errors into our codes and texts, tells
// the chat which shown messages a repeated model call dropped and the name the conversation got.
import { CHAT_EVENTS } from '@bba/contracts';
import { logEvent } from '../log/log.ts';
import { createDiscardTracker } from './discards.ts';

export interface TranslatedError {
  code: string;
  message: string;
}

export interface RunStreamHooks {
  onEnd(): void;
  translate(rawMessage: string): Promise<TranslatedError>;
  // Events to put right after RUN_STARTED (e.g. results of calls cancelled before the turn).
  afterStart: object[];
  // Ids of Mastra responses whose model call broke and was asked again, since the last call (spec, 9.1).
  takeDiscarded(): string[];
  // The naming call that runs beside the answer (spec, section 8.16); null when there is none.
  title: { threadId: string; result: Promise<string | null>; waitAtEndMs: number } | null;
}

const isEvent = (line: string, type: string) => line.startsWith('data:') && line.includes(`"${type}"`);

// The name goes to the chat as soon as it is known, between events of the run — after its start and
// before its end, as AG-UI allows nothing else. The end of the run waits for a call still under way,
// but only so long; the name shows at the next refresh of «Недавние» then.
function createTitleAnnouncer(title: RunStreamHooks['title']) {
  let name: string | null = null;
  let settled = title === null;
  let sent = false;
  let started = false;
  let finished = false;
  // The naming call never fails (core/chat/naming.ts): its failure is logged there and gives null.
  void title?.result.then((value) => {
    name = value;
    settled = true;
  });
  return {
    // The end of the run is due and the name may still come: wait for it (`wait`) first.
    mustWait: (line: string) => started && !finished && !settled && isEvent(line, 'RUN_FINISHED'),
    async wait(): Promise<void> {
      if (!title) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([title.result, new Promise((resolve) => (timer = setTimeout(resolve, title.waitAtEndMs)))]);
      clearTimeout(timer);
    },
    pass(line: string): string {
      if (!started) {
        started = isEvent(line, 'RUN_STARTED');
        return line;
      }
      if (finished || !line.startsWith('data:')) return line;
      finished = isEvent(line, 'RUN_FINISHED') || isEvent(line, 'RUN_ERROR');
      if (sent || name === null) return line;
      sent = true;
      return [`data: ${JSON.stringify({ type: 'CUSTOM', name: CHAT_EVENTS.threadTitled, value: { threadId: title!.threadId, title: name } })}`, '', line].join('\n');
    },
  };
}

async function rewriteEvent(line: string, hooks: RunStreamHooks): Promise<string> {
  if (!line.startsWith('data:')) return line;
  const json = line.slice(5).trim();
  if (!json.includes('"RUN_ERROR"')) return line;
  try {
    const event = JSON.parse(json) as { type?: string; message?: string; code?: string };
    if (event.type !== 'RUN_ERROR') return line;
    const translated = await hooks.translate(event.message ?? '');
    logEvent('warn', 'chat_run_error', { code: translated.code, raw: (event.message ?? '').slice(0, 300) });
    return `data: ${JSON.stringify({ ...event, code: translated.code, message: translated.message })}`;
  } catch (error) {
    logEvent('error', 'chat_run_error_rewrite_failed', { error });
    return line;
  }
}

export function wrapRunResponse(res: Response, hooks: RunStreamHooks): Response {
  if (!res.body) {
    hooks.onEnd();
    return res;
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let ended = false;
  let started = false;
  const discards = createDiscardTracker(() => hooks.takeDiscarded());
  const titles = createTitleAnnouncer(hooks.title);
  const withPrelude = (line: string): string => {
    if (started || hooks.afterStart.length === 0 || !line.includes('"RUN_STARTED"')) return line;
    started = true;
    return [line, '', ...hooks.afterStart.flatMap((e) => [`data: ${JSON.stringify(e)}`, ''])].join('\n');
  };
  // Lines of the run with whatever is due before each: dropped messages, then the name. What came
  // before the end of the run goes out before the end waits for the name — the last words are not held.
  const emit = async (lines: string[], controller: ReadableStreamDefaultController<Uint8Array>) => {
    const out: string[] = [];
    const flush = () => {
      if (out.length > 0) controller.enqueue(encoder.encode(out.splice(0).map((l) => `${l}\n`).join('')));
    };
    for (const line of lines) {
      const rewritten = discards.pass(await rewriteEvent(line, hooks));
      if (titles.mustWait(rewritten)) {
        flush();
        await titles.wait();
      }
      out.push(withPrelude(titles.pass(rewritten)));
    }
    flush();
  };
  const end = () => {
    if (!ended) {
      ended = true;
      hooks.onEnd();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer) await emit([buffer], controller);
          const rest = discards.rest();
          if (rest) controller.enqueue(encoder.encode(rest));
          controller.close();
          end();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        await emit(lines, controller);
      } catch (error) {
        end();
        controller.error(error);
      }
    },
    async cancel(reason) {
      end();
      await reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
