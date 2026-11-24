// Complaints about answers, samples of good documents and the report of value
// (docs/specs/[20.11.2026]-feedback-and-value.md).
import { z } from 'zod';

export const SUPPORT_STATUSES = ['new', 'in_progress', 'resolved', 'rejected'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

// A complaint about an answer, or a request written straight from «Мои обращения» (F7, owner 24.11).
export type SupportKind = 'complaint' | 'request';

export const COMPLAINT_MAX = 4000;

// The turn complained about: the number of the person's message it answers among the person's messages of the
// conversation — the same live and after a reload.
export const complaintSchema = z.strictObject({
  threadId: z.string().min(1).max(300),
  turn: z.number().int().min(1).max(1_000_000),
  comment: z.string().trim().min(1).max(COMPLAINT_MAX),
});

// The files of a ticket, all of them together: those of a conversation copied with a complaint, or those the employee
// attached to a request.
export const SUPPORT_FILES_MAX_BYTES = 50 * 1024 * 1024;
export const SUPPORT_REQUEST_FILES_MAX = 10;
export const SUPPORT_SUBJECT_MAX = 200;

// A field of a form with files: the browser sends each line break as «\r\n», which the text box counted as one character —
// brought back to «\n» before it is measured. A zero character Postgres cannot keep is refused.
const formText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value),
    z.string().trim().min(1).max(max).refine((v) => !v.includes('\0'), 'zero character'),
  );

// POST /app/api/me/support/requests: the text fields of the form; the files go as `files`.
export const supportRequestSchema = z.strictObject({
  subject: formText(SUPPORT_SUBJECT_MAX),
  text: formText(COMPLAINT_MAX),
});

export interface SupportRequestResponse {
  id: string;
}

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
  // Copied (and every file attached to a request); not copied — over 50 MB a complaint; the file was removed before the
  // complaint.
  state: 'copied' | 'too_large' | 'gone';
}

export interface MyTicketDto {
  id: string;
  kind: SupportKind;
  // The subject of a request; null — a complaint.
  subject: string | null;
  // The agent complained about; null — a request.
  agentName: string | null;
  status: SupportStatus;
  comment: string;
  // The names of the files the person attached to a request; a complaint — none.
  files: string[];
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
  kind: SupportKind;
  // The subject of a request; null — a complaint.
  subject: string | null;
  // The agent complained about; null — a request.
  agentId: string | null;
  agentName: string | null;
  status: SupportStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AdminTicketsResponse {
  tickets: AdminTicketRow[];
}

// A request has no turn, copy of a conversation, models, instructions or task.
export interface AdminTicketDto extends AdminTicketRow {
  comment: string;
  turn: number | null;
  snapshot: SupportSnapshotMessage[];
  files: SupportFileDto[];
  models: string[];
  // When the instructions in use were published; null — those of the agent's file.
  instructionsAt: string | null;
  taskId: string | null;
  reply: string | null;
  handledBy: string | null;
}

// The states a ticket goes to from each (section 17): a closed one only opens again («Открыть снова»).
export const SUPPORT_NEXT: Record<SupportStatus, readonly SupportStatus[]> = {
  new: ['new', 'in_progress', 'resolved', 'rejected'],
  in_progress: ['in_progress', 'resolved', 'rejected'],
  resolved: ['resolved', 'in_progress'],
  rejected: ['rejected', 'in_progress'],
};

// `seen` — when the ticket the page shows was last changed: a colleague's answer given meanwhile is never overwritten.
export const ticketUpdateSchema = z.strictObject({
  status: z.enum(SUPPORT_STATUSES),
  reply: z.string().trim().max(COMPLAINT_MAX).nullable(),
  seen: z.iso.datetime(),
});

// A sample (F4): a document the agent made in a conversation goes into the knowledge base of a department of the person
// (or of the organisation, for the one who keeps it).
// The kind of a sample goes into the prompt of every agent of the base's readers: one line of words, nothing else — no
// line breaks, no marks of Markdown, no control characters.
export const cleanDocType = (text: string) =>
  [...text.replace(/[^\p{L}\p{N} .,()«»"'\-–—]+/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, 100).join('');

// A file of a conversation of the person (the heart of a sample, F6; owner 24.11): DELETE /app/api/me/examples takes it
// as the query.
export const exampleFileSchema = z.strictObject({
  threadId: z.string().min(1).max(300),
  path: z.string().min(1).max(1000),
});

// One press of the heart: the kind of the document the server guesses from its name.
export const exampleSaveSchema = exampleFileSchema.extend({
  base: z.discriminatedUnion('scope', [z.strictObject({ scope: z.literal('org') }), z.strictObject({ scope: z.literal('department'), departmentId: z.uuid() })]),
});

export type ExampleBase = { scope: 'org'; name: string } | { scope: 'department'; departmentId: string; name: string };

// GET /app/api/me/examples?threadId=: where a sample of the person may go, and the files of the conversation the person
// put into a base that keeps them still — a file the agent wrote anew under the same name stays marked.
export interface ExampleMarksResponse {
  bases: ExampleBase[];
  saved: string[];
}

// The documents the heart is offered on: Word, Excel, PowerPoint, PDF and their open and older forms.
const EXAMPLE_EXTENSIONS = new Set(['.docx', '.doc', '.odt', '.rtf', '.xlsx', '.xls', '.ods', '.pptx', '.ppt', '.odp', '.pdf']);
export const isExampleName = (name: string) => EXAMPLE_EXTENSIONS.has(name.slice(name.lastIndexOf('.')).toLowerCase());

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
  // The departments under 3 people together; null when there are none or fewer than 3 people did anything in them.
  otherDepartments: ValueCounts | null;
  // Agents used by 3 people or more; the others together, under the same rule.
  agents: ({ id: string; name: string } & ValueCounts)[];
  otherAgents: ValueCounts | null;
  // Some work is in no row shown: a group of fewer than 3 people.
  hidden: boolean;
  spendRub: number;
  subscriptionCalls: number;
}

export const valueNormsSchema = z.strictObject({
  norms: z.strictObject(Object.fromEntries(WORK_KINDS.map((k) => [k, z.number().int().min(0).max(600)])) as Record<WorkKind, z.ZodNumber>),
  hourRub: z.number().min(0.01).max(1_000_000).nullable(),
});
