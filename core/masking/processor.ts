// Mastra processor that masks personal data on the way to the model and restores it on the way back
// (spec, section 8.11; mechanism verified at step 0, V8):
//   processLLMRequest   — the outgoing prompt only; stored history keeps the real values;
//   processOutputStep   — tool-call arguments before the tool runs;
//   processOutputStream — the text streamed to the person, including a placeholder cut between chunks.
// Any failure stops the request: data is never sent unmasked "just in case".
import { WIDGET_TOOL } from '@bba/contracts';
import type { Processor } from '@mastra/core/processors';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { REQUEST_KEYS, requireContextValue } from '../run-context/request-keys.ts';
import { createThreadMasker, isPlaceholderPrefix, type ThreadMasker } from './masker.ts';
import { getMaskingKinds } from './settings.ts';

// Keys that hold identifiers, binary data or protocol fields rather than text the person wrote.
const SKIPPED_KEYS = new Set(['type', 'role', 'toolCallId', 'toolName', 'mediaType', 'data', 'url', 'id', 'providerOptions', 'providerMetadata']);
// Inside a widget the agent drew (spec, section 8.31) `data` (the rows of a chart), `id`, `type`, `url` are what the
// screen shows: only the fields of the call itself are skipped there (review 20.11).
const WIDGET_CALL_KEYS = new Set(['type', 'toolCallId', 'toolName', 'providerOptions', 'providerMetadata']);
const NOTHING_SKIPPED = new Set<string>();
const BUFFER_KEY = 'bbaMaskingTail';

type Ctx = { get(key: string): unknown } | undefined;

async function mapStrings(value: unknown, fn: (s: string) => Promise<string>, skipped: ReadonlySet<string> = SKIPPED_KEYS): Promise<unknown> {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return Promise.all(value.map((v) => mapStrings(v, fn, skipped)));
  if (value && typeof value === 'object' && !(value instanceof Uint8Array) && !(value instanceof URL)) {
    const widget = (value as { toolName?: unknown }).toolName === WIDGET_TOOL.render;
    const here = widget ? WIDGET_CALL_KEYS : skipped;
    const inside = widget ? NOTHING_SKIPPED : skipped;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = here.has(k) ? v : await mapStrings(v, fn, inside);
    return out;
  }
  return value;
}

function mapStringsSync(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStringsSync(v, fn));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStringsSync(v, fn)]));
  return value;
}

export function createMaskingProcessor(db: Db) {
  // One masker per request, shared by the request and output hooks of that request.
  const perRequest = new WeakMap<object, Promise<ThreadMasker | null>>();

  function maskerFor(ctx: Ctx): Promise<ThreadMasker | null> {
    if (!ctx) return Promise.reject(new Error('masking needs a request context'));
    const cached = perRequest.get(ctx);
    if (cached) return cached;
    const created = (async () => {
      const kinds = await getMaskingKinds(db);
      if (kinds.size === 0) return null;
      return createThreadMasker(db, requireContextValue(ctx, REQUEST_KEYS.threadId), kinds);
    })();
    perRequest.set(ctx, created);
    return created;
  }

  return {
    id: 'bba-masking',
    async processLLMRequest({ prompt, requestContext }) {
      try {
        const masker = await maskerFor(requestContext);
        if (!masker) return undefined;
        return { prompt: (await mapStrings(prompt, (s) => masker.mask(s))) as typeof prompt };
      } catch (error) {
        throw appError('APP_MASKING_FAILED', 'masking of the outgoing prompt failed; the model was not called', { cause: error });
      }
    },

    async processOutputStep({ toolCalls, requestContext, messageList }) {
      const masker = await maskerFor(requestContext);
      if (!masker) return messageList;
      for (const call of toolCalls ?? []) {
        if (!call.args || typeof call.args !== 'object') continue;
        const args = call.args as Record<string, unknown>;
        const unknown = masker.unknownPlaceholders(JSON.stringify(args));
        // A placeholder the model made up has no real value: the tool must not run with it.
        // Replacing the arguments makes schema validation fail, so the model gets an error instead.
        const restored = unknown.length > 0 ? { unknownPlaceholders: unknown } : (mapStringsSync(args, (s) => masker.unmask(s)) as Record<string, unknown>);
        for (const key of Object.keys(args)) delete args[key];
        Object.assign(args, restored);
      }
      return messageList;
    },

    async processOutputStream({ part, requestContext, state }) {
      const masker = await maskerFor(requestContext);
      if (!masker) return part;
      if (part.type === 'text-delta') {
        const text = String((state[BUFFER_KEY] as string | undefined) ?? '') + part.payload.text;
        const open = text.lastIndexOf('[');
        const holdBack = open !== -1 && isPlaceholderPrefix(text.slice(open));
        state[BUFFER_KEY] = holdBack ? text.slice(open) : '';
        return { ...part, payload: { ...part.payload, text: masker.unmask(holdBack ? text.slice(0, open) : text) } };
      }
      if (part.type === 'tool-call') {
        return { ...part, payload: { ...part.payload, args: mapStringsSync(part.payload.args, (s) => masker.unmask(s)) as typeof part.payload.args } };
      }
      return part;
    },
  } satisfies Processor;
}
