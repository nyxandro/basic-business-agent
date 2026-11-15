// The longest answer of a model as the gateway knows it (spec, section 8.19): LiteLLM's model map
// (/public/litellm_model_cost_map) keeps `max_output_tokens` under the name «provider/model», or
// under the bare model name with `litellm_provider` set — the way OpenAI's models are kept
// (`gpt-4.1-mini`). The lookup follows that order, as LiteLLM's own get_model_info does.

interface MapEntry {
  litellm_provider?: unknown;
  max_output_tokens?: unknown;
}

const isEntry = (value: unknown): value is MapEntry => typeof value === 'object' && value !== null;

function limitOf(entry: unknown): number | null {
  if (!isEntry(entry)) return null;
  const limit = entry.max_output_tokens;
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : null;
}

export function outputLimitIn(map: Record<string, unknown>, providerModel: string): number | null {
  const exact = limitOf(map[providerModel]);
  if (exact !== null) return exact;
  const slash = providerModel.indexOf('/');
  if (slash < 0) return null;
  const bare = map[providerModel.slice(slash + 1)];
  return isEntry(bare) && bare.litellm_provider === providerModel.slice(0, slash) ? limitOf(bare) : null;
}
