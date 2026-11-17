// The agent's tools for the folder of the person's computer (spec, section 8.25), run by this browser: what
// is in a folder, files found by name, a file read. A text file comes back as text; a document, a picture or
// an archive is copied into the hidden folder «.computer» of the conversation's working folder, where the
// skills read it — the agent gets its path there. The tools exist only while the folder is connected and
// the browser lets it be read; otherwise the agent is told what the person should do.
import { COMPUTER_COPIES, COMPUTER_TOOLS, MAX_UPLOAD_BYTES } from '@bba/contracts';
import { useFrontendTools } from '@copilotkit/react-core';
import { useMemo } from 'react';
import { z } from 'zod';
import { apiForm } from '../api/client.ts';
import { accessOf, fileAt, findFiles, FolderError, listEntries, type ComputerFolder } from './computer-folder.ts';

// Text up to this size goes to the agent as it is; anything bigger or not text — into the working folder.
const MAX_TEXT_BYTES = 200 * 1024;
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'yaml', 'yml', 'log', 'ini', 'cfg', 'conf', 'toml', 'sql', 'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rb', 'php', 'sh', 'bat', 'css', 'scss', 'eml', 'vcf', 'srt']);

const ext = (path: string) => path.split('.').pop()?.toLowerCase() ?? '';

type Result = Record<string, unknown>;

// Every failure becomes a text the agent can retell: a tool of the browser that throws would leave the
// answer without a result.
async function answer(folder: ComputerFolder, work: () => Promise<Result>): Promise<Result> {
  try {
    if ((await accessOf(folder)) !== 'granted') {
      return { error: `Нет доступа к папке «${folder.name}»: попросите сотрудника нажать «Разрешить доступ» у папки над полем ввода.` };
    }
    return await work();
  } catch (error) {
    if (error instanceof FolderError) return { error: error.message };
    return { error: `Не удалось прочитать папку «${folder.name}»: ${(error as Error).message}` };
  }
}

async function copyToServer(threadId: string, path: string, file: File): Promise<Result> {
  if (file.size > MAX_UPLOAD_BYTES) return { error: `Файл «${path}» больше 20 МБ — его не прочитать.` };
  const form = new FormData();
  form.append('path', path);
  form.append('file', file, file.name);
  const saved = await apiForm<{ path: string; bytes: number }>(`/app/api/threads/${encodeURIComponent(threadId)}/computer-file`, form);
  return { path: saved.path, bytes: saved.bytes, note: `Файл скопирован в рабочую папку: ${saved.path}. Прочитай его скиллом по этому пути.` };
}

// The tools of a connected folder for the conversation `threadId`.
export function computerTools(folder: ComputerFolder, threadId: string) {
  const where = `в папке «${folder.name}» на компьютере сотрудника (папка подключена к проекту)`;
  return [
    {
      name: COMPUTER_TOOLS.list,
      description: `Что лежит ${where}: файлы с размером и датой и вложенные папки. Путь — от корня этой папки; без пути — сам корень.`,
      parameters: z.object({ path: z.string().optional().describe('Вложенная папка, например «Договоры/2026»') }),
      handler: ({ path }: { path?: string }) => answer(folder, async () => ({ folder: folder.name, ...(await listEntries(folder, path ?? '')) })),
    },
    {
      name: COMPUTER_TOOLS.find,
      description: `Поиск файлов ${where} по словам в имени и пути, во всех вложенных папках.`,
      parameters: z.object({ query: z.string().describe('Слова из имени файла или папки') }),
      handler: ({ query }: { query: string }) => answer(folder, async () => ({ folder: folder.name, ...(await findFiles(folder, query)) })),
    },
    {
      name: COMPUTER_TOOLS.read,
      description: `Читает файл ${where}. Текст возвращается сразу; документ, картинка или архив копируется в рабочую папку (${COMPUTER_COPIES}/…), и ты читаешь его скиллом по выданному пути.`,
      parameters: z.object({ path: z.string().describe('Путь файла от корня папки') }),
      handler: ({ path }: { path: string }) =>
        answer(folder, async () => {
          const file = await fileAt(folder, path);
          if (TEXT_EXTENSIONS.has(ext(path)) && file.size <= MAX_TEXT_BYTES) return { path, bytes: file.size, text: await file.text() };
          return copyToServer(threadId, path, file);
        }),
    },
  ];
}

export function useComputerTools(folder: ComputerFolder | null, threadId: string): void {
  const tools = useMemo(() => (folder ? computerTools(folder, threadId) : []), [folder, threadId]);
  // CopilotKit registers a tool again only when its name or description changes: another folder of the same
  // name must replace the handlers too.
  useFrontendTools(tools, [folder, threadId]);
}
