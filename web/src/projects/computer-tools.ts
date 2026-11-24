// The agent's tools for the folder of the person's computer (spec, section 8.25), run by this browser: what
// is in a folder, files found by name, a file read, and — for a folder given «Читать и записывать» — files written
// (computer-saves.ts: «Да» on a card of the chat, a snapshot on the server, then the write). A text file comes back as
// text; a document, a picture or an archive is copied into the hidden folder «.computer» of the conversation's working
// folder, where the skills read it — the agent gets its path there. The tools exist only while the folder is connected;
// without the browser's leave the agent is told what the person should do. A call left without its answer by a reload
// of the page runs again (`resume-pending`): a read is safe to repeat, and a write asks «Да» anew.
import { COMPUTER_COPIES, COMPUTER_TOOLS, MAX_UPLOAD_BYTES, type ComputerWriteResult } from '@bba/contracts';
import { useFrontendTools } from '@copilotkit/react-core';
import { useEffect, useMemo } from 'react';
import { z } from 'zod';
import { apiForm } from '../api/client.ts';
import { accessOf, fileAt, findFiles, FolderError, listEntries, partsOf, type ComputerFolder, type FolderAccess, type HandleFolder } from './computer-folder.ts';
import { askToWrite, changedSinceRead, noteRead, saveToComputer, setThreadFolder, stopPendingWrites, threadFolderNow, type WriteAskItem } from './computer-saves.ts';
import { ensureWritable, targetOf, writableFolder } from './computer-write.ts';

// Text up to this size goes to the agent as it is; anything bigger or not text — into the working folder.
const MAX_TEXT_BYTES = 200 * 1024;
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'yaml', 'yml', 'log', 'ini', 'cfg', 'conf', 'toml', 'sql', 'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rb', 'php', 'sh', 'bat', 'css', 'scss', 'eml', 'vcf', 'srt']);

const ext = (path: string) => path.split('.').pop()?.toLowerCase() ?? '';

type Result = Record<string, unknown>;

// What the agent says to the person when the folder cannot be used now.
function noAccessText(folder: ComputerFolder, access: FolderAccess): string {
  if (access === 'missing') return `Папки «${folder.name}» больше нет на компьютере: её переместили, удалили или отключили диск. Попросите сотрудника выбрать её заново.`;
  if (access === 'denied') return `Браузер запретил этому сайту доступ к папке «${folder.name}»: сотрудник может разрешить его в настройках сайта (значок слева от адреса).`;
  return `Нет доступа к папке «${folder.name}»: попросите сотрудника нажать «Разрешить доступ» у папки над полем ввода.`;
}

// Every failure becomes a text the agent can retell: a tool of the browser that throws would leave the
// answer without a result. Reading needs only the right to read, whatever the folder's mode.
async function answer(folder: ComputerFolder, work: () => Promise<Result>): Promise<Result> {
  try {
    const access = await accessOf(folder, 'read');
    if (access !== 'granted') return { error: noAccessText(folder, access) };
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

// At most this many files a write: one card of «Да» the person can read.
const MAX_WRITTEN = 10;

const writeArgs = z.object({
  files: z
    .array(
      z.object({
        file: z.string().describe('Путь файла в рабочей папке, например «КП ООО Ёлка.docx» или «.computer/…/Договор.docx»'),
        to: z.string().describe('Путь в папке компьютера вместе с именем файла, например «КП/2026/КП ООО Ёлка.docx»'),
        replace: z.boolean().optional().describe('true — заменить файл, который там уже есть'),
      }),
    )
    .min(1)
    .max(MAX_WRITTEN),
});

type WriteContext = { toolCall: { id: string }; signal?: AbortSignal };

// What the person is asked: where each file goes and what is there now. A file in the way without `replace` stops the
// write before any question — the agent decides again.
async function asksOf(folder: HandleFolder, files: z.infer<typeof writeArgs>['files']): Promise<WriteAskItem[] | { error: string }> {
  const items: WriteAskItem[] = [];
  for (const f of files) {
    const target = await targetOf(folder, f.to);
    if (target.exists && !f.replace) return { error: `Файл «${target.path}» уже есть в папке «${folder.name}». Чтобы заменить его, повтори с replace: true; чтобы сохранить рядом — выбери другое имя.` };
    if (items.some((i) => i.to === target.path)) return { error: `Два файла не записать в одно место: «${target.path}».` };
    items.push({ file: f.file, to: target.path, replace: f.replace === true, exists: target.exists, changedSinceRead: changedSinceRead(folder, target.path, target.exists) });
  }
  return items;
}

async function writeFiles(folder: HandleFolder, threadId: string, args: z.infer<typeof writeArgs>, context: WriteContext): Promise<ComputerWriteResult> {
  // The targets are looked at with the right to read: without it the person is asked to give it back first.
  const access = await accessOf(folder, 'read');
  if (access !== 'granted') return { error: noAccessText(folder, access) };
  const looked = await asksOf(folder, args.files);
  if ('error' in looked) return looked;
  const answer = await askToWrite(context.toolCall.id, { threadId, folder: folder.name, items: looked }, context.signal);
  if (answer === 'stopped') return { error: 'Запись не сделана: ответ остановили.' };
  if (answer === 'no') return { declined: true, message: 'Сотрудник отказался записывать файлы на компьютер. Не записывай их снова, пока он сам не попросит.' };
  // While the card waited the person may have turned the folder to reading, chosen another or let it go.
  const now = threadFolderNow(threadId);
  if (!now || now.handle !== folder.handle || now.mode !== 'readwrite') return { error: `Папку «${folder.name}» переключили на «Только читать» или отключили — ничего не записано.` };
  // Right after the click of «Да»: the browser may ask the person for the right to write.
  await ensureWritable(folder);
  const written = [];
  for (const item of looked) written.push(await saveToComputer(folder, threadId, item));
  return { folder: folder.name, items: written };
}

// The tool's answer is the agent's only news of the write: a failure of the browser is told in words, never thrown —
// a thrown handler leaves the answer of the agent cut off.
async function writeOrSay(folder: HandleFolder, threadId: string, args: z.infer<typeof writeArgs>, context: WriteContext): Promise<ComputerWriteResult> {
  try {
    return await writeFiles(folder, threadId, args, context);
  } catch (error) {
    if (error instanceof FolderError) return { error: error.message };
    return { error: `Не удалось записать в папку «${folder.name}»: ${(error as Error).message}` };
  }
}

// The tools of a connected folder for the conversation `threadId`.
export function computerTools(folder: ComputerFolder, threadId: string) {
  const where = `в папке «${folder.name}» на компьютере сотрудника (папка подключена к проекту)`;
  const writable = writableFolder(folder);
  const write = writable
    ? [
        {
          name: COMPUTER_TOOLS.write,
          description:
            `Записывает файлы из рабочей папки ${where}: новый файл или замена того, что там есть. Сотрудник видит в чате, что и куда, и подтверждает «Да». ` +
            'Записывай, только когда сотрудник просит сохранить на компьютер или когда ты правил файл, прочитанный с компьютера (тогда — на его место, с replace: true). ' +
            'Удалять и переименовывать файлы на компьютере нельзя.',
          parameters: writeArgs,
          reconnectBehavior: 'resume-pending' as const,
          handler: (args: z.infer<typeof writeArgs>, context: WriteContext) => writeOrSay(writable, threadId, args, context),
        },
      ]
    : [];
  return [
    {
      name: COMPUTER_TOOLS.list,
      description: `Что лежит ${where}: файлы с размером и датой и вложенные папки. Путь — от корня этой папки; без пути — сам корень.`,
      parameters: z.object({ path: z.string().optional().describe('Вложенная папка, например «Договоры/2026»') }),
      reconnectBehavior: 'resume-pending' as const,
      handler: ({ path }: { path?: string }) => answer(folder, async () => ({ folder: folder.name, ...(await listEntries(folder, path ?? '')) })),
    },
    {
      name: COMPUTER_TOOLS.find,
      description: `Поиск файлов ${where} по словам в имени и пути, во всех вложенных папках.`,
      parameters: z.object({ query: z.string().describe('Слова из имени файла или папки') }),
      reconnectBehavior: 'resume-pending' as const,
      handler: ({ query }: { query: string }) => answer(folder, async () => ({ folder: folder.name, ...(await findFiles(folder, query)) })),
    },
    {
      name: COMPUTER_TOOLS.read,
      description: `Читает файл ${where}. Текст возвращается сразу; документ, картинка или архив копируется в рабочую папку (${COMPUTER_COPIES}/…), и ты читаешь его скиллом по выданному пути.`,
      parameters: z.object({ path: z.string().describe('Путь файла от корня папки') }),
      reconnectBehavior: 'resume-pending' as const,
      handler: ({ path }: { path: string }) =>
        answer(folder, async () => {
          const file = await fileAt(folder, path);
          // A write over this file later warns when the person saved it after this read.
          if (folder.kind === 'handle') noteRead(folder, partsOf(path).join('/'), file.lastModified);
          if (TEXT_EXTENSIONS.has(ext(path)) && file.size <= MAX_TEXT_BYTES) return { path, bytes: file.size, text: await file.text() };
          return copyToServer(threadId, path, file);
        }),
    },
    ...write,
  ];
}

export function useComputerTools(folder: ComputerFolder | null, threadId: string): void {
  const tools = useMemo(() => (folder ? computerTools(folder, threadId) : []), [folder, threadId]);
  // CopilotKit registers a tool again only when its name or description changes: another folder of the same
  // name must replace the handlers too.
  useFrontendTools(tools, [folder, threadId]);
  // The blocks of the conversation's writes put a replaced version back into this folder.
  useEffect(() => {
    if (!folder || folder.kind !== 'handle') return;
    setThreadFolder(threadId, folder);
    return () => setThreadFolder(threadId, null);
  }, [folder, threadId]);
  // The conversation closed: a write it waits on gives up, nothing is written.
  useEffect(() => () => stopPendingWrites(threadId), [threadId]);
}
