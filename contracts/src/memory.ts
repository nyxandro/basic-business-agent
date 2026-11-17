// Memory of a project and of an employee (spec, section 8.26): short facts the agents and people keep
// between conversations — on the page of a project and in «Моя память».
import { z } from 'zod';

// One fact: the server turns line breaks into spaces and refuses anything longer.
export const MEMORY_ENTRY_MAX_CHARS = 400;
// Above this share of the limit the page warns that the memory is nearly full.
export const MEMORY_NEARLY_FULL_SHARE = 0.8;

export interface MemoryEntryDto {
  id: string;
  // What the agent names the entry by.
  number: number;
  text: string;
  // A change is saved over the version it was made on (APP_MEMORY_CONFLICT otherwise).
  version: number;
  // Who changed it last: `name` is null once that person was removed from the installation.
  editor: { name: string | null; byAgent: boolean; you: boolean };
  updatedAt: string;
}

export interface MemoryListDto {
  // The latest change first.
  entries: MemoryEntryDto[];
  usedChars: number;
  maxChars: number;
  // A project in the archive: read only.
  readOnly: boolean;
}

// The server checks the 400 signs after it joined the lines; a body far over it is refused unread.
export const memoryEntryInputSchema = z.object({ text: z.string().max(4000) });
export const memoryEntryChangeSchema = z.object({ text: z.string().max(4000), version: z.number().int().positive() });
