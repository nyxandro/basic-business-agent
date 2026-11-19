// The search of the internet (spec, section 8.30): through the gateway's own search (`/v1/search/<tool>`), on the
// employee's key like a model call; SearXNG of the installation behind it for now (decisions of the owner 19.11 —
// free, no keys, not counted in the spending). Another engine later is a change of the gateway's entry only.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Db } from '../db/pool.ts';
import { AppError, isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import type { ModelGateway } from '../models/gateway.ts';
import { SEARCH_TOOL_NAME } from '../models/litellm-config.ts';
import type { AnyTool } from '../plugins/public/index.ts';
import { REQUEST_KEYS, requireContextValue } from '../runtime/request-keys.ts';
import { logEvent } from '../server/log.ts';
import { PERSONAL_DATA_MESSAGE, personalDocumentIn } from './personal-data.ts';
import { countSearch } from './fetch-tool.ts';

export const WEB_SEARCH_TOOL = 'web_search';
const SEARCH_WAIT_MS = 20_000;
// Russian results first: SearXNG reads it as the language of the search.
const SEARCH_COUNTRY = 'ru';
export const SEARCH_DEFAULT_RESULTS = 5;
const SEARCH_MAX_RESULTS = 10;

export interface SearchHit {
  title: string;
  // Not `url`: the masking skips fields of that name, and an address may hold a person's data (8.30).
  address: string;
  snippet: string;
  date: string | null;
}

export interface WebSearcher {
  search(input: { query: string; maxResults: number; userId: string; agentId: string }): Promise<SearchHit[]>;
}

const responseSchema = z.object({
  results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string().nullish(), date: z.string().nullish() })),
});

export function createGatewaySearcher(gateway: Pick<ModelGateway, 'modelConfig' | 'translateError'>): WebSearcher {
  return {
    async search({ query, maxResults, userId, agentId }) {
      // The employee's key and the agent's header, as for a model: the gateway counts the call and checks the limits.
      const call = await gateway.modelConfig(SEARCH_TOOL_NAME, userId, agentId);
      let res: Response;
      try {
        res = await fetch(`${call.url}/search/${SEARCH_TOOL_NAME}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${call.apiKey}`, 'content-type': 'application/json', ...call.headers },
          body: JSON.stringify({ query, max_results: maxResults, country: SEARCH_COUNTRY }),
          signal: AbortSignal.timeout(SEARCH_WAIT_MS),
        });
      } catch (error) {
        throw appError('APP_WEB_SEARCH_FAILED', `the gateway's search did not answer: ${error instanceof Error ? error.name : 'unknown'}`, { cause: error });
      }
      if (!res.ok) {
        const failure = Object.assign(new Error(`search failed with ${res.status}`), { status: res.status, responseBody: (await res.text()).slice(0, 2000) });
        const translated = await gateway.translateError(failure, userId);
        // The limits are the gateway's answer for search too; anything else is the search being down.
        if (translated.code === 'APP_USAGE_LIMIT_EXCEEDED' || translated.code === 'APP_USAGE_ORG_LIMIT_EXCEEDED') throw translated;
        throw appError('APP_WEB_SEARCH_FAILED', `search failed with ${res.status}`, { cause: failure });
      }
      const parsed = responseSchema.safeParse(await res.json());
      if (!parsed.success) throw appError('APP_WEB_SEARCH_FAILED', `the gateway's search answered in an unknown form: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
      return parsed.data.results.slice(0, maxResults).map((r) => ({ title: r.title, address: r.url, snippet: r.snippet ?? '', date: r.date ?? null }));
    },
  };
}

// What the model reads of a failure: the fix it can make, not the gateway's words.
function failureOf(error: AppError): { error: true; code: string; message: string } {
  if (error.code === 'APP_USAGE_LIMIT_EXCEEDED' || error.code === 'APP_USAGE_ORG_LIMIT_EXCEEDED') {
    return { error: true, code: error.code, message: `Поиск не выполнен: ${error.userMessage} Не повторяй поиск, скажи об этом.` };
  }
  return { error: true, code: 'APP_WEB_SEARCH_FAILED', message: 'Поисковик не ответил. Попробуй ещё раз с другой формулировкой; если не получится — верни, что поиск сейчас недоступен.' };
}

export function createWebSearchTool(deps: { db: Db; searcher: WebSearcher }): AnyTool {
  return createTool({
    id: WEB_SEARCH_TOOL,
    description:
      'Найти страницы в интернете по запросу. Возвращает заголовки, адреса и короткие выдержки; чтобы прочитать страницу, открой её адрес web_fetch. Пиши запрос так, как ищет человек, по-русски, если ищешь российское.',
    inputSchema: z.object({
      query: z.string().min(1).max(400).describe('Поисковый запрос'),
      max_results: z.number().int().min(1).max(SEARCH_MAX_RESULTS).default(SEARCH_DEFAULT_RESULTS).describe('Сколько результатов вернуть, 1–10'),
    }),
    execute: async ({ query, max_results }, context) => {
      const ctx = context?.requestContext;
      if (await personalDocumentIn(deps.db, query, WEB_SEARCH_TOOL)) return { error: true, code: 'APP_WEB_PERSONAL_DATA', message: PERSONAL_DATA_MESSAGE };
      const started = Date.now();
      try {
        const results = await deps.searcher.search({ query, maxResults: max_results, userId: requireContextValue(ctx, REQUEST_KEYS.userId), agentId: requireContextValue(ctx, REQUEST_KEYS.agentId) });
        countSearch(ctx);
        logEvent('info', 'web_search_done', { ms: Date.now() - started, results: results.length });
        return { results };
      } catch (error) {
        if (!isAppError(error)) throw error;
        logEvent('warn', 'web_search_failed', { code: error.code, ms: Date.now() - started });
        return failureOf(error);
      }
    },
  }) as AnyTool;
}
