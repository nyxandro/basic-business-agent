// Wraps the AG-UI event stream of a chat run: releases the conversation when the stream ends
// (normally or because the browser left), turns raw run errors into our codes and texts, tells
// the chat which shown messages a repeated model call dropped and the name the conversation got.
import { CHAT_EVENTS } from '@bba/contracts';
import { logEvent } from '../server/log.ts';
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

// The name goes to the chat as soon as it is known, between events of the run; the end of the run
// waits for a call still under way, but only so long — the name shows at the next refresh then.
function createTitleAnnouncer(title: RunStreamHooks['title']) {
  let name: string | null = null;
  let settled = title === null;
  let sent = false;
  let started = false;
  // The naming call never fails (core/chat/naming.ts): its failure is logged there and gives null.
  void title?.result.then((value) => {
    name = value;
    settled = true;
  });
  const due = (line: string): string => {
    if (sent || name === null) return line;
    sent = true;
    return [`data: ${JSON.stringify({ type: 'CUSTOM', name: CHAT_EVENTS.threadTitled, value: { threadId: title!.threadId, title: name } })}`, '', line].join('\n');
  };
  return {
    async pass(line: string): Promise<string> {
      if (!started) {
        started = isEvent(line, 'RUN_STARTED');
        return line;
      }
      if (!line.startsWith('data:')) return line;
      if (isEvent(line, 'RUN_FINISHED') && !settled && title) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([title.result, new Promise((resolve) => (timer = setTimeout(resolve, title.waitAtEndMs)))]);
        clearTimeout(timer);
      }
      return due(line);
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
  // A line of the run with whatever is due before it: dropped messages, then the name.
  const rewrite = async (line: string) => titles.pass(discards.pass(await rewriteEvent(line, hooks)));
  const withPrelude = (line: string): string => {
    if (started || hooks.afterStart.length === 0 || !line.includes('"RUN_STARTED"')) return line;
    started = true;
    return [line, '', ...hooks.afterStart.flatMap((e) => [`data: ${JSON.stringify(e)}`, ''])].join('\n');
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
          if (buffer) controller.enqueue(encoder.encode(await rewrite(buffer)));
          const rest = discards.rest();
          if (rest) controller.enqueue(encoder.encode(rest));
          controller.close();
          end();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        const out: string[] = [];
        for (const line of lines) out.push(withPrelude(await rewrite(line)));
        controller.enqueue(encoder.encode(out.map((l) => `${l}\n`).join('')));
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
