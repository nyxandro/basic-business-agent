// How long the gateway waits on a provider (decision of the owner 15.11): every chat deployment gets
// the limit of silence in a stream, every deployment the limit of one request, and a change of the
// limits reaches the deployments already in LiteLLM at the next start.
import { describe, expect, it } from 'vitest';
import { deploymentsOf, type SyncState } from './gateway-sync.ts';

const PRICES = { input: 35, output: 140, cacheRead: 9, cacheWrite: 35, reasoning: 140, image: 35 };
const TIMEOUTS = { silenceSeconds: 60, requestSeconds: 300 };

const STATE: SyncState = {
  models: [
    { id: 'm-chat', kind: 'chat', connection: 'api_key', providerModel: 'openai/qwen3.8-flash', apiBase: 'https://llm.example.com/v1', enabled: true, prices: PRICES, pricePerMinute: null, maxOutputTokens: 16_384 },
    { id: 'm-speech', kind: 'transcription', connection: 'api_key', providerModel: 'groq/whisper-large-v3', apiBase: null, enabled: true, prices: null, pricePerMinute: 0.5, maxOutputTokens: null },
    { id: 'm-sub', kind: 'chat', connection: 'chatgpt', providerModel: 'chatgpt/gpt-5.4', apiBase: null, enabled: true, prices: null, pricePerMinute: null, maxOutputTokens: null },
  ],
  keys: [
    { id: 'k-chat', modelId: 'm-chat', secret: 'sk-chat' },
    { id: 'k-speech', modelId: 'm-speech', secret: 'sk-speech' },
  ],
  accounts: [{ id: 'acc-1' }],
};

const byId = (timeouts = TIMEOUTS) => new Map(deploymentsOf(STATE, 'bba', timeouts).map((d) => [d.id, d]));

describe('limits of waiting on a provider in the gateway', () => {
  it('a chat model on a key or a subscription is cut after a minute of silence; any request after five minutes', () => {
    const all = byId();
    expect(all.get('m-chat:k-chat')?.params).toMatchObject({ stream_timeout: 60, timeout: 300 });
    expect(all.get('m-sub:acc-1')?.params).toMatchObject({ stream_timeout: 60, timeout: 300 });
    // Speech is not streamed: only the limit of the request.
    expect(all.get('m-speech:k-speech')?.params).toMatchObject({ timeout: 300 });
    expect(all.get('m-speech:k-speech')?.params).not.toHaveProperty('stream_timeout');
  });

  it('new limits change the fingerprint: the start brings models already in the gateway to them', () => {
    const before = byId();
    const after = byId({ silenceSeconds: 90, requestSeconds: 300 });
    for (const id of ['m-chat:k-chat', 'm-sub:acc-1']) expect(after.get(id)?.info.bba_fingerprint).not.toBe(before.get(id)?.info.bba_fingerprint);
  });
});
