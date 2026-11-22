// The knowledge base of the organisation (docs/specs/[20.11.2026]-knowledge-base.md): documents of the organisation and
// of departments, read into fragments the agents search by words, and the synonyms people add.
import { z } from 'zod';

export const KB_SCOPES = ['org', 'department'] as const;
export type KbScope = (typeof KB_SCOPES)[number];

export interface KbDocumentDto {
  id: string;
  title: string;
  // A document, or a sample of a good document (docs/specs/[20.11.2026]-feedback-and-value.md).
  kind: 'document' | 'example';
  // The kind of a sample («Коммерческое предложение») and who marked it; null for a document.
  docType: string | null;
  markedBy: string | null;
  // «Редакция от» — the date the agent names in a reference (YYYY-MM-DD).
  editionDate: string | null;
  // The version agents search; null — none read yet.
  currentVersion: number | null;
  latestVersion: number;
  // How the latest version was read: «Разбираю…», «Готов», a refusal with its code.
  status: 'pending' | 'ready' | 'rejected';
  warning: string | null;
  errorCode: string | null;
  chunks: number | null;
  fileName: string;
  size: number;
  updatedAt: string;
}

export interface KbDocumentsResponse {
  documents: KbDocumentDto[];
}

// The bases the person keeps: the organisation's and those of their departments with «Документы отдела».
export interface KbBasesResponse {
  org: boolean;
  departments: { id: string; name: string }[];
}

export const kbDocumentPatchSchema = z.strictObject({
  title: z.string().max(200).optional(),
  editionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export interface KbSynonymGroupDto {
  id: string;
  words: string[];
}

export const kbSynonymGroupSchema = z.strictObject({ words: z.array(z.string().max(100)).min(2).max(20) });

// What `knowledge_search` found, for the block «База знаний» under the answer.
export interface KbFragmentDto {
  ref: string;
  docId: string;
  version: number;
  document: string;
  // A sample: its kind («Коммерческое предложение») — structure and tone to follow, not data to copy.
  example?: string;
  section: string | null;
  page: number | null;
  edition: string | null;
  text: string;
}
