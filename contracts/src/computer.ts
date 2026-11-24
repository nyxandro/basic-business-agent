// A folder of the person's computer given to a project (spec, section 8.25): the browser answers the agent's
// tools about it. The names of the tools, how the chat names them, and the hidden folder of the working
// folder where a file the agent reads is copied for the skills.
import { z } from 'zod';
export const COMPUTER_TOOLS = {
  list: 'computer_folder_list',
  find: 'computer_folder_find',
  read: 'computer_folder_read',
  write: 'computer_folder_write',
} as const;

export const COMPUTER_SYSTEM = 'Компьютер';

export const COMPUTER_ACTION_TITLES: Record<(typeof COMPUTER_TOOLS)[keyof typeof COMPUTER_TOOLS], string> = {
  computer_folder_list: 'Список файлов в папке с компьютера',
  computer_folder_find: 'Поиск файлов в папке с компьютера',
  computer_folder_read: 'Чтение файла из папки с компьютера',
  computer_folder_write: 'Запись файлов в папку на компьютере',
};

// Inside the working folder of the conversation; hidden — not among «Файлы проекта», not stored (8.23).
export const COMPUTER_COPIES = '.computer';

// A file written onto the computer (8.25, «Запись в папку»): its snapshot — `.computer-saved/<person>/<number>/<name>`, what
// the chat opens later — and the version it replaced — `…/before/<name>`, kept 30 days. Hidden, stored in a bucket.
export const COMPUTER_SAVES = '.computer-saved';
export const COMPUTER_BEFORE = 'before';

// POST /app/api/threads/:threadId/computer-saves.
export interface ComputerSaveResponse {
  id: string;
  name: string;
  bytes: number;
  snapshot: string;
  previous: string | null;
}

// What computer_folder_write answers, one item a file: written — with the snapshot the chat opens and the version it
// replaced (null for a new file); or why not. The person said «Нет» — `declined`; nothing was asked — `error`.
export const computerWriteItemSchema = z.union([
  z.object({ to: z.string(), written: z.literal(true), name: z.string(), bytes: z.number(), snapshot: z.string(), previous: z.string().nullable(), replaced: z.boolean() }),
  z.object({ to: z.string(), written: z.literal(false), error: z.string() }),
]);
export type ComputerWriteItem = z.infer<typeof computerWriteItemSchema>;

export const computerWriteResultSchema = z.union([
  z.object({ folder: z.string(), items: z.array(computerWriteItemSchema) }),
  z.object({ declined: z.literal(true), message: z.string() }),
  z.object({ error: z.string() }),
]);
export type ComputerWriteResult = z.infer<typeof computerWriteResultSchema>;
