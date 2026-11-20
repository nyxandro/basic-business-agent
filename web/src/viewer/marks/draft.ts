// The unsent marks of a file (spec, section 8.32; decision of the owner 20.11, F44): kept in this browser per
// conversation and file until they are sent (a conversation is always one person's), with the version of the file they were drawn on. Storage may be
// unavailable (private mode): then the marks live while the viewer is open, and the person is told.
import { z } from 'zod';
import { COMMENT_MAX, MARK_TOOLS, type Mark } from './types.ts';

export interface MarksDraft {
  // The version of the file (`version` of its status): marks of another version are not for this one.
  version: string;
  marks: Mark[];
}

export type StoredDraft = { state: 'none' } | { state: 'found'; draft: MarksDraft } | { state: 'unavailable' };

const share = z.number().min(0).max(1);
const markSchema = z
  .object({
    id: z.string().min(1),
    page: z.number().int().min(1),
    tool: z.enum(MARK_TOOLS),
    points: z.array(z.object({ x: share, y: share })).min(1),
    comment: z.string().max(COMMENT_MAX),
  })
  // Only the line of the pen has more than its two ends.
  .refine((m) => m.tool === 'pen' || m.points.length === 2);
const draftSchema = z.object({ version: z.string().min(1), marks: z.array(markSchema) });

export const draftKey = (threadId: string, path: string): string => `bba:marks:${threadId}:${path}`;

export const serializeDraft = (draft: MarksDraft): string => JSON.stringify(draft);

// What another version of the app or a hand left under the key is no draft.
export function parseDraft(text: string): MarksDraft | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = draftSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function readStoredDraft(key: string): StoredDraft {
  let text: string | null;
  try {
    text = localStorage.getItem(key);
  } catch {
    return { state: 'unavailable' };
  }
  const draft = text === null ? null : parseDraft(text);
  return draft ? { state: 'found', draft } : { state: 'none' };
}

// False when the browser keeps nothing; an empty draft is removed.
export function storeDraft(key: string, draft: MarksDraft | null): boolean {
  try {
    if (draft && draft.marks.length > 0) localStorage.setItem(key, serializeDraft(draft));
    else localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
