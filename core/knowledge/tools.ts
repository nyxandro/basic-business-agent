// The agent's tools of the knowledge base (docs/specs/[20.11.2026]-knowledge-base.md, section 7): `knowledge_search` —
// fragments with their document, section, page and edition; `knowledge_open` — the document whole, copied into the
// working folder of the conversation, read by the skills of documents (no reading tool of its own — owner 19.11).
// The person's access decides, in a shared project too (owner 21.11, F3). Errors go to the model as text.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Db } from '../db/pool.ts';
import { isAppError } from '../errors/app-error.ts';
import type { AnyTool } from '../plugins/public/index.ts';
import { optionalContextValue, requireContextValue, REQUEST_KEYS } from '../runtime/request-keys.ts';
import { recordFact } from '../work-facts/facts.ts';
import { runRoot } from '../sandbox/workspace.ts';
import { logEvent } from '../server/log.ts';
import { saveInFolder } from '../workspace/layout.ts';
import { searchKnowledge } from './search.ts';
import { documentFile } from './store.ts';

export const KNOWLEDGE_TOOLS = { search: 'knowledge_search', open: 'knowledge_open' } as const;
export const KNOWLEDGE_FOLDER = '.work/knowledge';

// The search is by words only (owner 22.11, F4): the model is told to try other words when nothing came.
export const WORDS_NOTE = 'Поиск только по словам: если не нашёл, повтори запрос другими словами — синонимами и ключевыми терминами. В ответе называй документ, раздел и редакцию. Не нашёл и после этого — так и скажи: «в базе знаний этого нет»; свои знания помечай как общую практику, не правило компании.';
// Samples (docs/specs/[20.11.2026]-feedback-and-value.md, section 7): looked for first, followed in form, never in data.
export const EXAMPLES_NOTE =
  "Делая документ (КП, письмо, договор, акт), сначала найди образцы такого вида: kind: 'example' с видом документа в запросе. Из образца бери структуру, разделы и тон; клиента, цифры, цены, контакты и реквизиты — только из текущей задачи, базы знаний и профиля, никогда из образца.";
export const OPEN_NOTE = 'Документ скопирован в рабочую папку: читай его скиллами документов.';

type Ctx = { requestContext?: { get(key: string): unknown } } | undefined;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The model gets the error as text; a failure of the server is also logged here, at the tool's boundary.
function failure(tool: string, error: unknown) {
  if (isAppError(error)) return { error: true, code: error.code, message: error.userMessage };
  logEvent('error', 'knowledge_tool_failed', { code: 'APP_INTERNAL', tool, error });
  return { error: true, code: 'APP_INTERNAL', message: 'Поиск в базе знаний не удался.' };
}

export function createKnowledgeTools(deps: { db: Db; workspaceRoot: string }): Record<string, AnyTool> {
  const search = createTool({
    id: KNOWLEDGE_TOOLS.search,
    description:
      'Поиск в базе знаний организации: регламенты, положения, прайсы, условия договоров, процессы компании. Вызывай на вопросы о правилах, ценах, сроках, условиях и процессах компании — до ответа. Не для общих знаний и не для файлов проекта. ' +
      EXAMPLES_NOTE +
      ' ' +
      WORDS_NOTE,
    inputSchema: z.object({
      query: z.string().min(2).max(300).describe('Ключевые слова вопроса'),
      document: z.string().optional().describe('Номер документа (docId), если искать только в нём'),
      kind: z.enum(['any', 'example']).optional().describe("'example' — только образцы документов (КП, письма, договоры), когда делаешь такой документ"),
    }),
    execute: async ({ query, document, kind }, ctx) => {
      // A title or a reference instead of the number of a document: the model is told what the parameter takes.
      if (document !== undefined && !UUID.test(document)) return { error: true, code: 'APP_VALIDATION_FAILED', message: 'document — это docId документа из прошлого результата knowledge_search (вида 0b1c…-…), не название и не ref. Повтори без него или с docId.' };
      try {
        const userId = requireContextValue((ctx as Ctx)?.requestContext, REQUEST_KEYS.userId);
        const fragments = await searchKnowledge(deps.db, userId, query, document ?? null, kind ?? 'any');
        // An answer by the base is a fact of the report of value (docs/specs/[20.11.2026]-feedback-and-value.md).
        if (fragments.length > 0) await recordFact(deps.db, 'knowledge_answer', { userId, agentId: optionalContextValue((ctx as Ctx)?.requestContext, REQUEST_KEYS.agentId) });
        return { found: fragments.length, mode: 'words' as const, fragments, note: fragments.some((f) => f.example) ? `${EXAMPLES_NOTE} ${WORDS_NOTE}` : WORDS_NOTE };
      } catch (error) {
        return failure(KNOWLEDGE_TOOLS.search, error);
      }
    },
  });
  const open = createTool({
    id: KNOWLEDGE_TOOLS.open,
    description: 'Взять документ базы знаний целиком: копия в рабочую папку разговора, чтобы дочитать его скиллами документов.',
    inputSchema: z.object({ docId: z.string().uuid().describe('Номер документа из knowledge_search') }),
    execute: async ({ docId }, ctx) => {
      try {
        const requestContext = (ctx as Ctx)?.requestContext;
        const userId = requireContextValue(requestContext, REQUEST_KEYS.userId);
        const file = await documentFile(deps.db, userId, docId, null);
        const saved = saveInFolder(runRoot(deps.workspaceRoot, requestContext), KNOWLEDGE_FOLDER, file.name, new Uint8Array(file.content), { anyType: true });
        return { path: saved.path, note: OPEN_NOTE };
      } catch (error) {
        return failure(KNOWLEDGE_TOOLS.open, error);
      }
    },
  });
  return { [search.id]: search as AnyTool, [open.id]: open as AnyTool };
}
