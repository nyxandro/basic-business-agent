// A core tool (spec, section 8.18): shows the employee a file the agent made — the chat draws a block
// with its name, size and «Скачать» (web/src/genui/FileBlock.tsx). Only a file of the folder of the
// conversation; anything else goes back to the model with a hint, and the chat draws nothing.
import { COMPUTER_COPIES, fileBlockResultSchema, GENUI_TOOL, type FileBlockResult } from '@bba/contracts';
import { realpathSync, statSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { isAppError } from '../errors/app-error.ts';
import type { AnyTool } from '../plugins/public/index.ts';
import { existingInside } from '../workspace/layout.ts';
import { runRoot } from './workspace.ts';
import { optionalContextValue, REQUEST_KEYS } from '../run-context/request-keys.ts';
import { isDocumentName, type WorkFacts } from '../work-facts/facts.ts';

const HINT = 'Сохрани файл в рабочую папку и вызови show_file с путём к нему.';

// A copy of a file of the person's computer the browser brought (spec, section 8.25) is the person's, not the agent's.
const isComputerCopy = (path: string) => path.split('/')[0] === COMPUTER_COPIES;

// The clock of file times runs a few milliseconds behind the clock of the process: a file written right after the start
// may get a time a little before it.
const FILE_CLOCK_SLACK_MS = 50;

// `startedAt` — the start of the run: a file changed since then the agent made in this answer (an attachment of the person
// came before it).
export function showFileIn(root: string, path: string, startedAt: number | null = null): FileBlockResult {
  let real: string | null;
  try {
    real = existingInside(root, path);
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { shown: false, error: `Путь «${path}» ведёт за пределы рабочей папки. ${HINT}` };
  }
  if (!real) return { shown: false, error: `Файла «${path}» нет в рабочей папке. ${HINT}` };
  const stat = statSync(real);
  if (!stat.isFile()) return { shown: false, error: `«${path}» — папка, а не файл. ${HINT}` };
  return { shown: true, path: relative(realpathSync(root), real), name: basename(real), bytes: stat.size, made: startedAt !== null && stat.mtimeMs >= startedAt - FILE_CLOCK_SLACK_MS && !isComputerCopy(relative(realpathSync(root), real)) };
}

// The documents already counted in this run: showing the same file twice is one document.
const COUNTED = 'bba.documentsCounted';

export function createShowFileTool(workspaceRoot: string, facts: WorkFacts | null): AnyTool {
  return createTool({
    id: GENUI_TOOL.file,
    description:
      'Показать сотруднику готовый файл из рабочей папки: в чате появится карточка с именем, размером и кнопкой «Скачать». ' +
      'Вызывай для каждого файла, который сделал для сотрудника (документ, таблица, презентация, PDF), после того как сохранил его в рабочую папку. ' +
      'Черновики, распакованные папки и картинки для проверки не показывай.',
    inputSchema: z.object({ path: z.string().min(1).describe('Путь от рабочей папки или абсолютный путь внутри неё, например «КП ООО Ёлка.docx»') }),
    outputSchema: fileBlockResultSchema,
    execute: async ({ path }, context) => {
      const rc = context?.requestContext;
      const started = optionalContextValue(rc, REQUEST_KEYS.runStartedAt);
      const shown = showFileIn(runRoot(workspaceRoot, rc), path, started === null ? null : Number(started));
      // A document the agent made in this answer is a fact of work (docs/specs/[20.11.2026]-feedback-and-value.md).
      if (facts && rc && shown.shown && shown.made && isDocumentName(shown.name)) {
        const seen: unknown = rc.get(COUNTED);
        const counted = seen instanceof Set ? (seen as Set<string>) : new Set<string>();
        if (!counted.has(shown.path)) {
          counted.add(shown.path);
          rc.set(COUNTED, counted);
          await facts.record('document', { userId: optionalContextValue(rc, REQUEST_KEYS.userId), agentId: optionalContextValue(rc, REQUEST_KEYS.agentId), runKind: optionalContextValue(rc, REQUEST_KEYS.runKind) });
        }
      }
      return shown;
    },
  }) as AnyTool;
}
