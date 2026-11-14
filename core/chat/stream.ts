// Wraps the AG-UI event stream of a chat run: releases the conversation when the stream ends
// (normally or because the browser left) and turns raw run errors into our codes and texts.
import { logEvent } from '../server/log.ts';

export interface TranslatedError {
  code: string;
  message: string;
}

export interface RunStreamHooks {
  onEnd(): void;
  translate(rawMessage: string): Promise<TranslatedError>;
  // Events to put right after RUN_STARTED (e.g. results of calls cancelled before the turn).
  afterStart: object[];
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
          if (buffer) controller.enqueue(encoder.encode(await rewriteEvent(buffer, hooks)));
          controller.close();
          end();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        const out: string[] = [];
        for (const line of lines) out.push(withPrelude(await rewriteEvent(line, hooks)));
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
