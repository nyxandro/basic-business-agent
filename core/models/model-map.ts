// What the gateway knows of a model (LiteLLM's model map, /public/litellm_model_cost_map): the longest answer
// (`max_output_tokens`, spec, section 8.19) and the size of the context (`max_input_tokens`, section 8.34). The map
// keeps a model under the name «provider/model», or under the bare model name with `litellm_provider` set — the way
// OpenAI's models are kept (`gpt-4.1-mini`). The lookup follows that order, as LiteLLM's own get_model_info does.

type LimitField = 'max_output_tokens' | 'max_input_tokens';

type MapEntry = Partial<Record<LimitField | 'litellm_provider', unknown>>;

const isEntry = (value: unknown): value is MapEntry => typeof value === 'object' && value !== null;

function limitOf(entry: unknown, field: LimitField): number | null {
  if (!isEntry(entry)) return null;
  const limit = entry[field];
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : null;
}

function limitIn(map: Record<string, unknown>, providerModel: string, field: LimitField): number | null {
  const exact = limitOf(map[providerModel], field);
  if (exact !== null) return exact;
  const slash = providerModel.indexOf('/');
  if (slash < 0) return null;
  const bare = map[providerModel.slice(slash + 1)];
  return isEntry(bare) && bare.litellm_provider === providerModel.slice(0, slash) ? limitOf(bare, field) : null;
}

export const outputLimitIn = (map: Record<string, unknown>, providerModel: string): number | null => limitIn(map, providerModel, 'max_output_tokens');

export const inputLimitIn = (map: Record<string, unknown>, providerModel: string): number | null => limitIn(map, providerModel, 'max_input_tokens');
