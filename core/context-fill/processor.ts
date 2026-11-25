// How full a conversation is (spec, section 8.34). After every call of the model of the agent the person talks to,
// Mastra gives this processor the model that answered and the chunks of its answer; the last chunk carries what the
// call took, as the provider counted it (the gateway passes it in the stream: always_include_stream_usage). What went
// in plus what came out — the answer goes into the next request — is kept for the conversation and told to the chat.
import type { ThreadContextFill } from '@bba/contracts';
import type { Processor } from '@mastra/core/processors';
import type { Db } from '../db/pool.ts';
import { logEvent } from '../log/log.ts';
import { optionalContextValue, REQUEST_KEYS, requireContextValue } from '../run-context/request-keys.ts';
import { fillOf, recordFill } from './store.ts';

export type ContextFillTell = (threadId: string, context: ThreadContextFill | null) => void;

interface StepChunk {
  type: string;
  payload?: unknown;
}

const tokenCount = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);

// The call's own usage — not Mastra's sum over the answer, which grows with every call of a turn.
export function callTokens(chunks: readonly StepChunk[]): number | null {
  const finish = chunks.findLast((c) => c.type === 'finish');
  const payload = finish?.payload as { output?: { usage?: { inputTokens?: unknown; outputTokens?: unknown } } } | undefined;
  const input = tokenCount(payload?.output?.usage?.inputTokens);
  const output = tokenCount(payload?.output?.usage?.outputTokens);
  return input === null || output === null ? null : input + output;
}

export function createContextFillProcessor(deps: { db: Db }) {
  return {
    id: 'bba-context-fill',
    async processLLMResponse({ chunks, model, requestContext, fromCache }) {
      // A draft check of a prompt is no conversation of the chat; a replayed answer took nothing; a call without its
      // last chunk (the stream broke) is not a call that answered.
      if (fromCache || optionalContextValue(requestContext, REQUEST_KEYS.runKind) === 'draft' || !chunks.some((c) => c.type === 'finish')) return;
      // The indicator is not worth an answer: whatever fails here is logged and the answer goes on — a throw would
      // count as a failure of the model, and with a fallback the call would be made, and paid, again.
      try {
        const threadId = requireContextValue(requestContext, REQUEST_KEYS.threadId);
        const tokens = callTokens(chunks);
        if (tokens === null) {
          logEvent('warn', 'context_fill_usage_missing', { threadId, modelId: model.modelId });
          return;
        }
        const userId = requireContextValue(requestContext, REQUEST_KEYS.userId);
        await recordFill(deps.db, { threadId, userId, modelId: model.modelId, tokens });
        const tell = requestContext?.get(REQUEST_KEYS.contextFill);
        if (typeof tell === 'function') (tell as ContextFillTell)(threadId, await fillOf(deps.db, userId, threadId));
      } catch (error) {
        logEvent('error', 'context_fill_record_failed', { modelId: model.modelId, error });
      }
    },
  } satisfies Processor;
}
