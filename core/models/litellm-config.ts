// LiteLLM configuration of an installation (spec, section 8.1): how it reports usage and failed
// attempts, routes over a pool and where it keeps models. Models are not in the file: the server
// puts the admin's models into LiteLLM's database (store_model_in_db), see gateway-sync.ts.
export const LEDGER_CALLBACK_NAME = 'bba_ledger';
// Every failed attempt of a deployment (each retry too), for the states of the ChatGPT accounts.
export const ACCOUNT_EVENTS_CALLBACK_NAME = 'bba_account_events';
// How long LiteLLM skips a deployment it cooled down; the account states show it as «вернётся в …».
export const COOLDOWN_SECONDS = 60;
// One retry moves a failed request to another account of the same pool (verified transient:
// a revoked or rate-limited account); LiteLLM logs it, so the retry is observable.
const POOL_RETRIES = 1;
const ALLOWED_FAILS_BEFORE_COOLDOWN = 1;
// LiteLLM resends a record our server did not take (a broken connection, a 5xx): 1+2+4+8+16 s cover
// a restart of the app. Both endpoints keep a record once, by its call id.
const CALLBACK_RETRIES = 5;
const CALLBACK_RETRY_DELAY_SECONDS = 1;
// The search of the internet (spec, section 8.30): one search tool of the gateway, SearXNG of the installation
// behind it for now (decision of the owner 19.11 — free, no keys); another engine later is a change of this entry.
export const SEARCH_TOOL_NAME = 'web-search';
const SEARCH_TIMEOUT_SECONDS = 15;
// SearXNG as the gateway reaches it in an installation and in development: a service of the same Compose project.
export const SEARXNG_URL_IN_COMPOSE = 'http://searxng:8080';

// A deployment written into the file. Only the test LiteLLM has them: mock models of the tests.
export interface StaticDeployment {
  modelName: string;
  id: string;
  params: Record<string, string | number | boolean>;
}

export interface LiteLLMConfigOptions {
  timezone: string;
  // POST /app/api/internal/usage of the server, as LiteLLM reaches it.
  callbackUrl: string;
  staticDeployments: StaticDeployment[];
  // SearXNG as the gateway reaches it.
  searchUrl: string;
}

const USAGE_PATH = '/app/api/internal/usage';

// Failed attempts go next to the usage records: /app/api/internal/account-events.
export function accountEventsUrlOf(usageUrl: string): string {
  if (!usageUrl.endsWith(USAGE_PATH)) throw new Error(`APP_CONFIG_INVALID: .env: LITELLM_CALLBACK_URL: must end with ${USAGE_PATH}`);
  return `${usageUrl.slice(0, -USAGE_PATH.length)}/app/api/internal/account-events`;
}

export function buildLiteLLMConfig(opts: LiteLLMConfigOptions): Record<string, unknown> {
  return {
    ...(opts.staticDeployments.length > 0
      ? { model_list: opts.staticDeployments.map((d) => ({ model_name: d.modelName, litellm_params: d.params, model_info: { id: d.id } })) }
      : {}),
    litellm_settings: {
      timezone: opts.timezone,
      callbacks: [LEDGER_CALLBACK_NAME, ACCOUNT_EVENTS_CALLBACK_NAME],
      turn_off_message_logging: true,
    },
    callback_settings: {
      [LEDGER_CALLBACK_NAME]: {
        callback_type: 'generic_api',
        endpoint: opts.callbackUrl,
        log_format: 'single',
        event_types: ['llm_api_success'],
        headers: { Authorization: 'os.environ/LITELLM_CALLBACK_AUTHORIZATION' },
        max_retries: CALLBACK_RETRIES,
        retry_delay: CALLBACK_RETRY_DELAY_SECONDS,
      },
      [ACCOUNT_EVENTS_CALLBACK_NAME]: {
        callback_type: 'generic_api',
        endpoint: accountEventsUrlOf(opts.callbackUrl),
        log_format: 'single',
        event_types: ['llm_api_failure'],
        headers: { Authorization: 'os.environ/LITELLM_CALLBACK_AUTHORIZATION' },
        max_retries: CALLBACK_RETRIES,
        retry_delay: CALLBACK_RETRY_DELAY_SECONDS,
      },
    },
    search_tools: [
      {
        search_tool_name: SEARCH_TOOL_NAME,
        litellm_params: { search_provider: 'searxng', api_base: opts.searchUrl, timeout: SEARCH_TIMEOUT_SECONDS },
        search_tool_info: { description: 'SearXNG of the installation' },
      },
    ],
    router_settings: {
      routing_strategy: 'simple-shuffle',
      num_retries: POOL_RETRIES,
      allowed_fails: ALLOWED_FAILS_BEFORE_COOLDOWN,
      cooldown_time: COOLDOWN_SECONDS,
    },
    general_settings: {
      master_key: 'os.environ/LITELLM_MASTER_KEY',
      database_url: 'os.environ/DATABASE_URL',
      // Provider keys in LiteLLM's database are encrypted with LITELLM_SALT_KEY.
      store_model_in_db: true,
      // Every stream ends with the count of tokens of its call, asked or not (spec, section 8.34): Mastra does not ask
      // for it (stream_options) for a model on its own address, and the chat shows how full a conversation is by it.
      // Read from general_settings only (LiteLLM 1.109.1, proxy/common_request_processing.py); without it the gateway
      // asks the provider for the count for its own ledger and cuts it out of the answer.
      always_include_stream_usage: true,
    },
  };
}
