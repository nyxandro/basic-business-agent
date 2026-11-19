// The researcher's tool for a page (spec, section 8.30): web_fetch over the reader of pages (fetch.ts). Each page is a
// step of the trail of the search (trail.ts): «читаю», then read or not, for the live block in the chat.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Db } from '../db/pool.ts';
import { isAppError } from '../errors/app-error.ts';
import type { AnyTool } from '../plugins/public/index.ts';
import { logEvent } from '../server/log.ts';
import { ADDRESS_MAX_CHARS, fetchFailureMessage, type PageReader } from './fetch.ts';
import { PERSONAL_DATA_MESSAGE, personalDocumentIn } from './personal-data.ts';
import { pageStepId, trailIn } from './trail.ts';

export const WEB_FETCH_TOOL = 'web_fetch';

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
      // Mastra's own signal of the run: «Стоп» of the person ends the download too.
      const stop = (context as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
      if (await personalDocumentIn(deps.db, address, WEB_FETCH_TOOL)) return { error: true, code: 'APP_WEB_PERSONAL_DATA', message: PERSONAL_DATA_MESSAGE };
      const host = hostOf(address);
      const trail = trailIn(context?.requestContext);
      const step = { kind: 'page' as const, id: pageStepId(address), address, host: host ?? address };
      // A page read before stays read when its next part does not come.
      const before = trail?.step(step.id);
      trail?.record({ ...step, state: 'running' });
      const started = Date.now();
      try {
        const page = await deps.reader.read(address, offset, stop);
        // The link may have led to another site: the row names the site of the page read.
        trail?.record({ ...step, address: page.final_address, host: hostOf(page.final_address) ?? step.host, title: page.title, state: 'done' });
        logEvent('info', 'web_fetch_done', { host, kind: page.kind, chars: page.total_chars, ms: Date.now() - started });
        return page;
      } catch (error) {
        trail?.record(before?.state === 'done' ? before : { ...step, state: 'failed', ...(isAppError(error) ? { code: error.code } : {}) });
        if (!isAppError(error)) throw error;
        logEvent('warn', 'web_fetch_failed', { host, code: error.code, ms: Date.now() - started });
        return { error: true, code: error.code, message: fetchFailureMessage(error.code, error.details) };
      }
    },
  }) as AnyTool;
}
