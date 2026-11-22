// Complaints about answers, samples of good documents and the report of value
// (docs/specs/[20.11.2026]-feedback-and-value.md).
import { z } from 'zod';

export const SUPPORT_STATUSES = ['new', 'in_progress', 'resolved', 'rejected'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const COMPLAINT_MAX = 4000;

// The turn complained about: the number of the person's message it answers among the person's messages of the
// conversation — the same live and after a reload.
export const complaintSchema = z.strictObject({
  threadId: z.string().min(1).max(300),
  turn: z.number().int().min(1),
  comment: z.string().trim().min(1).max(COMPLAINT_MAX),
});

export interface ComplaintResponse {
  id: string;
  // The complaint about this turn was there already: the comment was added to it.
  appended: boolean;
}

// The complaint already made about a turn: the dialog offers to add to it.
export interface ComplaintStateResponse {
  ticket: { id: string; status: SupportStatus } | null;
}

// A message of the copy of the conversation in a ticket: what the person saw.
export interface SupportSnapshotMessage {
  role: 'user' | 'assistant';
  at: string;
  text: string;
  marks: string[];
  // The turn the message is in (the number of the person's message it starts with or answers).
  turn: number;
}

export interface SupportFileDto {
  ord: number;
  name: string;
  size: number | null;
  // Copied; not copied — over 50 MB a complaint; the file was removed before the complaint.
  state: 'copied' | 'too_large' | 'gone';
}

export interface MyTicketDto {
  id: string;
  agentName: string;
  status: SupportStatus;
  comment: string;
  reply: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MyTicketsResponse {
  tickets: MyTicketDto[];
}

export interface AdminTicketRow {
  id: string;
  // Null — the person was removed: «бывший сотрудник».
  author: string | null;
  agentId: string;
  agentName: string;
  status: SupportStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AdminTicketsResponse {
  tickets: AdminTicketRow[];
}

export interface AdminTicketDto extends AdminTicketRow {
  comment: string;
  turn: number;
  snapshot: SupportSnapshotMessage[];
  files: SupportFileDto[];
  models: string[];
  // When the instructions in use were published; null — those of the agent's file.
  instructionsAt: string | null;
  taskId: string | null;
  reply: string | null;
  handledBy: string | null;
}

export const ticketUpdateSchema = z.strictObject({
  status: z.enum(SUPPORT_STATUSES),
  reply: z.string().trim().max(COMPLAINT_MAX).nullable(),
});

// A sample (F4): a document the agent made in a conversation goes into the knowledge base of a department of the person
// (or of the organisation, for the one who keeps it).
export const exampleSaveSchema = z.strictObject({
  threadId: z.string().min(1).max(300),
  path: z.string().min(1).max(1000),
  docType: z.string().trim().min(1).max(100),
  base: z.discriminatedUnion('scope', [z.strictObject({ scope: z.literal('org') }), z.strictObject({ scope: z.literal('department'), departmentId: z.uuid() })]),
});

// Where a sample may go and whether this file is one already.
export interface ExampleStateResponse {
  // none — not marked; saved — in the base now; removed — the keeper of the base took it out («Был образцом»).
  state: 'none' | 'saved' | 'removed';
  bases: ({ scope: 'org'; name: string } | { scope: 'department'; departmentId: string; name: string })[];
  // The kind of document guessed from its name: «Коммерческое предложение».
  docType: string;
}

export interface ExampleSaveResponse {
  documentId: string;
}

// The report of value (F2).
export const WORK_KINDS = ['document', 'action', 'email', 'background_run', 'web_research', 'knowledge_answer'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export interface ValueCounts {
  people: number;
  conversations: number;
  facts: Record<WorkKind, number>;
  minutes: number;
}

export interface ValueReport {
  from: string;
  to: string;
  // Facts are written from this day: earlier months have only the spend.
  factsSince: string;
  norms: Record<WorkKind, number>;
  hourRub: number | null;
  total: ValueCounts;
  departments: ({ id: string; name: string } & ValueCounts)[];
  // The departments under 3 people together.
  otherDepartments: ValueCounts | null;
  agents: ({ id: string; name: string } & ValueCounts)[];
  spendRub: number;
  subscriptionCalls: number;
}

export const valueNormsSchema = z.strictObject({
  norms: z.strictObject(Object.fromEntries(WORK_KINDS.map((k) => [k, z.number().int().min(0).max(600)])) as Record<WorkKind, z.ZodNumber>),
  hourRub: z.number().positive().max(1_000_000).nullable(),
});
