// A model answer that broke after it started (spec, section 9.1). LiteLLM does not repeat a stream
// that has already sent words, and Mastra's own retry does not recognise how the gateway reports
// such a break, so the agent gets Mastra's retry processor taught to: the step is asked once more on
// the same model. The repeated answer goes out as a new message and the chat is told which message
// to take off the screen; Mastra itself rolls the broken step back in the history.
import { StreamErrorRetryProcessor, type ErrorProcessor, type ProcessAPIErrorArgs } from '@mastra/core/processors';
import { logEvent } from '../server/log.ts';
import { optionalContextValue, REQUEST_KEYS } from './request-keys.ts';

// LiteLLM's proxy ends a stream that broke after it started with an error frame inside the stream
// ({"error": {"code": "500", ...}}, proxy_server.async_data_generator). These statuses are a
// provider or a connection that went away; a refusal of the request itself (4xx) repeats the same way.
const BROKEN_STREAM_STATUSES = new Set(['408', '500', '502', '503', '504']);

// One more attempt on the same model for a broken stream, with or without a fallback model: Mastra
// does not switch to the fallback on a broken stream (checked 15.11).
const BROKEN_STREAM_RETRIES = 1;

export function isGatewayStreamBreak(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return (typeof code === 'string' || typeof code === 'number') && BROKEN_STREAM_STATUSES.has(String(code));
}

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(error);
}

// Words of a failed attempt may already be on the screen when the model is asked again or the
// fallback answers instead: the new answer gets its own message so they are not glued to it, and
// the chat is told to drop them.
export function dropShownWords(args: Pick<ProcessAPIErrorArgs, 'messageId' | 'rotateResponseMessageId' | 'requestContext'>): void {
  const shown = args.messageId;
  args.rotateResponseMessageId?.();
  const discard = args.requestContext?.get(REQUEST_KEYS.messageDiscarded);
  if (shown && typeof discard === 'function') (discard as (messageId: string) => void)(shown);
}

// Takes the place of Mastra's default retry processor (the same id). `otherRetries` is how many
// times other transient failures — before the first words — are repeated on the same model: once
// without a fallback, never with one (the fallback answers instead).
export function createStreamRetry(otherRetries: number): ErrorProcessor {
  const retry = new StreamErrorRetryProcessor({ maxRetries: otherRetries, matchers: [{ match: isGatewayStreamBreak, maxRetries: BROKEN_STREAM_RETRIES }] });
  return {
    id: retry.id,
    async processAPIError(args: ProcessAPIErrorArgs) {
      const result = await retry.processAPIError(args);
      if (!result?.retry) return result;
      dropShownWords(args);
      logEvent('warn', 'model_stream_retried', {
        agentId: optionalContextValue(args.requestContext, REQUEST_KEYS.agentId),
        modelId: optionalContextValue(args.requestContext, REQUEST_KEYS.modelId),
        attempt: args.retryCount + 1,
        error: messageOf(args.error).slice(0, 300),
      });
      return result;
    },
  };
}
