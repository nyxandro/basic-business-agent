// A model answer that broke after it started (spec, section 9.1). LiteLLM does not repeat a stream
// that has already sent words, and Mastra's own retry does not recognise how the gateway reports
// such a break, so the agent's retry processor adds that: the step is asked once more on the same
// model. The repeated answer goes out as a new message and the chat is told which message to take
// off the screen; Mastra itself rolls the broken step back in the history.
import { defaultStabilityErrorProcessors, StreamErrorRetryProcessor, type ErrorProcessor, type ProcessAPIErrorArgs } from '@mastra/core/processors';
import { logEvent } from '../log/log.ts';
import { optionalContextValue, REQUEST_KEYS } from '../run-context/request-keys.ts';

const RETRY_PROCESSOR_ID = 'stream-error-retry-processor';

// LiteLLM's proxy ends a stream that failed after it started with an error frame inside the stream
// ({"error": {"message", "type", "param", "code": "500"}}, proxy_server.async_data_generator).
const STATUS = /^\d{3}$/;
// Of those, a provider or a connection that went away; a refusal of the request itself (4xx)
// repeats the same way.
const BROKEN_STREAM_STATUSES = new Set(['408', '500', '502', '503', '504']);

// One more attempt on the same model for a broken stream, with or without a fallback model: Mastra
// does not switch to the fallback on a failure inside the stream (checked 15.11).
const BROKEN_STREAM_RETRIES = 1;

// A failure the gateway reported inside the stream: a plain object, not an error of the call itself.
export function isGatewayStreamFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || error instanceof Error) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (typeof code === 'string' || typeof code === 'number') && STATUS.test(String(code)) && typeof message === 'string';
}

export function isGatewayStreamBreak(error: unknown): boolean {
  return isGatewayStreamFailure(error) && BROKEN_STREAM_STATUSES.has(String((error as { code: string | number }).code));
}

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(error);
}

// Words of a failed attempt may already be on the screen when the model is asked again or the
// fallback answers instead: the new answer gets its own message so they are not glued to it, and
// the chat is told to drop them. Whether anything was shown is known only to the chat stream (Mastra's
// message list may not hold the words yet, e.g. after a timeout); it announces only shown messages.
export function dropShownWords(args: Pick<ProcessAPIErrorArgs, 'messageId' | 'rotateResponseMessageId' | 'requestContext'>): void {
  const shown = args.messageId;
  if (!shown) return;
  args.rotateResponseMessageId?.();
  const discard = args.requestContext?.get(REQUEST_KEYS.messageDiscarded);
  if (typeof discard === 'function') (discard as (messageId: string) => void)(shown);
}

function mastraRetry(): ErrorProcessor {
  const processor = defaultStabilityErrorProcessors().find((p) => p.id === RETRY_PROCESSOR_ID);
  if (!processor?.processAPIError) throw new Error(`Mastra has no default ${RETRY_PROCESSOR_ID}: check @mastra/core after an update`);
  return processor;
}

// Takes the place of Mastra's default retry processor (the same id). Without a fallback model the
// other failures are repeated as Mastra does it by default (its own matchers, repeats and pauses);
// with one they are not repeated at all — the fallback answers instead.
export function createStreamRetry(opts: { mastraRetries: boolean }): ErrorProcessor {
  const others = opts.mastraRetries ? mastraRetry() : null;
  const breaks = new StreamErrorRetryProcessor({ maxRetries: 0, matchers: [{ match: isGatewayStreamBreak, maxRetries: BROKEN_STREAM_RETRIES }] });
  return {
    id: RETRY_PROCESSOR_ID,
    async processAPIError(args: ProcessAPIErrorArgs) {
      const result = (await others?.processAPIError(args)) ?? (await breaks.processAPIError(args));
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
