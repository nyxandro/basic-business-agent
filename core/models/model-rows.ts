// A row of app.models and what the gateway copy needs of it (catalog.ts, gateway-writer.ts).
import type { ModelConnection, ModelKind, TokenPrices } from '@bba/contracts';
import type { SyncModel } from './gateway-sync.ts';

export interface ModelRow {
  id: string;
  kind: ModelKind;
  label: string;
  connection: ModelConnection;
  provider_model: string;
  api_base: string | null;
  vision: boolean;
  enabled: boolean;
  price_input: string | null;
  price_output: string | null;
  price_cache_read: string | null;
  price_cache_write: string | null;
  price_reasoning: string | null;
  price_image: string | null;
  price_per_minute: string | null;
  max_output_tokens: number | null;
  max_input_tokens: number | null;
}

export const num = (v: string | null): number | null => (v === null ? null : Number(v));

export function pricesOf(r: ModelRow): TokenPrices | null {
  if (r.price_input === null) return null;
  return {
    input: Number(r.price_input),
    output: Number(r.price_output),
    cacheRead: Number(r.price_cache_read),
    cacheWrite: Number(r.price_cache_write),
    reasoning: Number(r.price_reasoning),
    image: Number(r.price_image),
  };
}

export function syncModelOf(r: ModelRow): SyncModel {
  return { id: r.id, kind: r.kind, connection: r.connection, providerModel: r.provider_model, apiBase: r.api_base, enabled: r.enabled, prices: pricesOf(r), pricePerMinute: num(r.price_per_minute), maxOutputTokens: r.max_output_tokens };
}
