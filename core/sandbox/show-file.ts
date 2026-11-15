// A core tool (spec, section 8.18): shows the employee a file the agent made — the chat draws a block
// with its name, size and «Скачать» (web/src/genui/FileBlock.tsx). Only a file of the folder of the
// conversation; anything else goes back to the model with a hint, and the chat draws nothing.
import { fileBlockResultSchema, GENUI_TOOL, type FileBlockResult } from '@bba/contracts';
import { realpathSync, statSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { isAppError } from '../errors/app-error.ts';
import type { AnyTool } from '../plugins/public/index.ts';
import { existingInside } from '../workspace/layout.ts';
import { runRoot } from './workspace.ts';

const HINT = 'Сохрани файл в рабочую папку и вызови show_file с путём к нему.';

export function showFileIn(root: string, path: string): FileBlockResult {
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
  return { shown: true, path: relative(realpathSync(root), real), name: basename(real), bytes: stat.size };
}

export function createShowFileTool(workspaceRoot: string): AnyTool {
  return createTool({
    id: GENUI_TOOL.file,
    description:
      'Показать сотруднику готовый файл из рабочей папки: в чате появится карточка с именем, размером и кнопкой «Скачать». ' +
      'Вызывай для каждого файла, который сделал для сотрудника (документ, таблица, презентация, PDF), после того как сохранил его в рабочую папку. ' +
      'Черновики, распакованные папки и картинки для проверки не показывай.',
    inputSchema: z.object({ path: z.string().min(1).describe('Путь от рабочей папки или абсолютный путь внутри неё, например «КП ООО Ёлка.docx»') }),
    outputSchema: fileBlockResultSchema,
    execute: ({ path }, context) => Promise.resolve(showFileIn(runRoot(workspaceRoot, context?.requestContext), path)),
  }) as AnyTool;
}
