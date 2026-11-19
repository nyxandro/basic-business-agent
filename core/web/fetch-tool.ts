// The researcher's tool for a page (spec, section 8.30): web_fetch over the reader of pages (fetch.ts). The sources
// the researcher read are gathered in the context of its task, for the answer of web_research.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Db } from '../db/pool.ts';
import { isAppError } from '../errors/app-error.ts';
import type { AnyTool } from '../plugins/public/index.ts';
import { logEvent } from '../server/log.ts';
import { ADDRESS_MAX_CHARS, fetchFailureMessage, type PageReader } from './fetch.ts';
import { PERSONAL_DATA_MESSAGE, personalDocumentIn } from './personal-data.ts';

export const WEB_FETCH_TOOL = 'web_fetch';
// A key of the researcher's own context (never of a run of an agent): what it read and searched.
export const WEB_SOURCES_KEY = 'bba.webSources';

export interface Sources {
  pages: Map<string, string>;
  searches: number;
}

export const newSources = (): Sources => ({ pages: new Map(), searches: 0 });
export const sourcesOf = (s: Sources) => [...s.pages].map(([address, title]) => ({ title, address }));

function sourcesIn(ctx: { get(key: string): unknown } | undefined): Sources | null {
  const value = ctx?.get(WEB_SOURCES_KEY);
  return value && typeof value === 'object' && 'pages' in value ? (value as Sources) : null;
}

// The host only: the rest of an address may hold a person's data, it is not logged.
function hostOf(address: string): string | null {
  try {
    return new URL(address).hostname;
  } catch {
    // Not an address at all: nothing to name in the log.
    return null;
  }
}

export function createWebFetchTool(deps: { db: Db; reader: PageReader }): AnyTool {
  return createTool({
    id: WEB_FETCH_TOOL,
    description:
      'Открыть страницу или документ по адресу и прочитать текст: страницы сайтов, PDF, Word, Excel, PowerPoint по ссылке. Длинный текст приходит частями — следующую часть даёт тот же адрес с offset из строки в конце текста.',
    inputSchema: z.object({
      address: z.string().min(1).max(ADDRESS_MAX_CHARS).describe('Адрес страницы, http:// или https://'),
      offset: z.number().int().min(0).default(0).describe('С какого знака текста читать; 0 — с начала'),
    }),
    execute: async ({ address, offset }, context) => {
      if (await personalDocumentIn(deps.db, address, WEB_FETCH_TOOL)) return { error: true, code: 'APP_WEB_PERSONAL_DATA', message: PERSONAL_DATA_MESSAGE };
      const host = hostOf(address);
      const started = Date.now();
      try {
        const page = await deps.reader.read(address, offset);
        sourcesIn(context?.requestContext)?.pages.set(page.final_address, page.title);
        logEvent('info', 'web_fetch_done', { host, kind: page.kind, chars: page.total_chars, ms: Date.now() - started });
        return page;
      } catch (error) {
        if (!isAppError(error)) throw error;
        logEvent('warn', 'web_fetch_failed', { host, code: error.code, ms: Date.now() - started });
        return { error: true, code: error.code, message: fetchFailureMessage(error.code, error.details) };
      }
    },
  }) as AnyTool;
}

// The search counts too, for the journal of a task.
export function countSearch(ctx: { get(key: string): unknown } | undefined): void {
  const sources = sourcesIn(ctx);
  if (sources) sources.searches++;
}
