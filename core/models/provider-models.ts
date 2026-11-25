// The size of the context as the provider tells it in its list of models (spec, section 8.34; decision of the owner
// 25.11: the system finds it itself) — for a model the gateway's map does not know, like a model of a provider's own
// address. Providers name the field differently: `limit.context` (the format of models.dev: neuraldeep),
// `context_window` (Groq), `context_length` (OpenRouter), `max_model_len` (vLLM).

// The list is read when a model is added and at start: a provider that hangs does not hold either for long.
const LIST_TIMEOUT_MS = 5_000;

// Providers on their standard address whose list tells the size; the lists of the others (OpenAI) do not.
const STANDARD_LIST_BASES: Readonly<Record<string, string>> = {
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const sizeOf = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null);

function entrySize(entry: Record<string, unknown>): number | null {
  const limit = entry.limit;
  return sizeOf(isRecord(limit) ? limit.context : undefined) ?? sizeOf(entry.context_window) ?? sizeOf(entry.context_length) ?? sizeOf(entry.max_model_len);
}

export function contextInList(list: unknown, modelId: string): number | null {
  if (!isRecord(list) || !Array.isArray(list.data)) return null;
  const entry = list.data.find((m): m is Record<string, unknown> => isRecord(m) && m.id === modelId);
  return entry ? entrySize(entry) : null;
}

// Where the list is and how the provider names the model there: LiteLLM's «provider/model» without the provider.
export function listBaseOf(m: { providerModel: string; apiBase: string | null }): { base: string; modelId: string } | null {
  const slash = m.providerModel.indexOf('/');
  if (slash < 0) return null;
  const base = m.apiBase ?? STANDARD_LIST_BASES[m.providerModel.slice(0, slash)];
  return base ? { base: base.replace(/\/+$/, ''), modelId: m.providerModel.slice(slash + 1) } : null;
}

// null — the provider has no list that tells the size, or does not name this model's. A failed request throws: the
// caller logs it and leaves the size empty for the next start.
export async function providerContextSize(m: { providerModel: string; apiBase: string | null }, key: string): Promise<number | null> {
  const where = listBaseOf(m);
  if (!where) return null;
  const res = await fetch(`${where.base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`the provider's list of models answered ${res.status}`);
  return contextInList(await res.json(), where.modelId);
}
