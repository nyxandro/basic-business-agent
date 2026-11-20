// What «Проверить и сохранить» tells the admin when LiteLLM's probe of a provider fails (spec, section 8.19).
// The probe of a new model carries what every request of the model carries, so a refusal of those
// parameters is told apart from a wrong key (#7): the limit of an answer above the provider's, and Groq's
// separate reasoning, which its models without reasoning do not take.
import type { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';

// LiteLLM 1.109.1 adds "\nstack trace: " and up to 1 000 characters of the traceback to the provider's
// error (main.py, ahealth_check); its lines of code may name any parameter, so only the part before it
// is read. The provider's own part may take several lines (Vertex AI answers with indented JSON).
const STACK_TRACE = '\nstack trace:';
const MESSAGE_MAX = 300;
const WRONG_KEY = /AuthenticationError|PermissionDeniedError|invalid[_ ]api[_ ]key|incorrect api key/i;
// The provider did not answer rather than refused the key.
const NO_ANSWER = /timeout|timed out|connection error|connecterror|connection refused|econnrefused|unreachable|name resolution|nodename/i;
// How providers name a limit of an answer they do not take: OpenAI and Groq, TGI, Gemini, vLLM and the
// like («maximum context length … you requested»), Groq's tokens per minute, which count the limit too.
const LIMIT_REFUSED = /max_tokens|max_completion_tokens|max_new_tokens|max_output_tokens|maxOutputTokens|context length|request too large/i;
const REASONING_REFUSED = /reasoning_format/i;
const NO_SEPARATE_REASONING = 'Эта модель Groq не умеет отдавать рассуждения отдельно от ответа, а база ждёт этого от всех моделей Groq. Выберите другую модель Groq.';

// `error` is LiteLLM's whole text with the key already taken out; `probeMaxTokens` — the model's limit the
// probe carried, if it did.
export function checkFailure(error: string, providerModel: string, probeMaxTokens: number | undefined): AppError {
  const cut = error.indexOf(STACK_TRACE);
  const provider = cut < 0 ? error : error.slice(0, cut);
  // For the journal and the technical message: the first line is enough to see what happened.
  const short = provider.split('\n')[0]!.slice(0, MESSAGE_MAX);
  if (WRONG_KEY.test(provider)) return appError('APP_MODEL_CHECK_FAILED', `provider check of ${providerModel} failed: ${short}`);
  if (probeMaxTokens !== undefined && LIMIT_REFUSED.test(provider)) {
    return appError('APP_MODEL_OUTPUT_LIMIT_REJECTED', `provider refused the limit of an answer ${probeMaxTokens} of ${providerModel}: ${short}`, {
      userMessage: `Провайдер не принял наибольшую длину ответа: ${probeMaxTokens.toLocaleString('ru-RU')}. Укажите меньшую — она есть в описании модели у провайдера (у Groq — «Max completion tokens»).`,
    });
  }
  if (REASONING_REFUSED.test(provider)) return appError('APP_MODEL_CHECK_FAILED', `provider refused separate reasoning of ${providerModel}: ${short}`, { userMessage: NO_SEPARATE_REASONING });
  return appError('APP_MODEL_CHECK_FAILED', `provider check of ${providerModel} failed: ${short}`, NO_ANSWER.test(provider) ? { userMessage: 'Провайдер не ответил. Попробуйте ещё раз.' } : {});
}
