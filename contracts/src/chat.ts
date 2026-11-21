import { z } from 'zod';
import type { AgentMark } from './interface.ts';

// Agents open to the person (GET /app/api/agents): what the chat list shows on its cards.
// What the confirmation card shows: the name of the action and the labels of its fields, taken
// from the tool's own description (spec, section 8.4).
export interface ActionDescription {
  title: string;
  fields: Record<string, string>;
  // Reads only: works without «Да» («только чтение» in the chat).
  readOnly: boolean;
  // How the card shows a value of a field with a fixed set of values (field → value → text): «act» reads «акт — …»
  // with the line about the consent of the other party (docs/specs/[20.11.2026]-org-letterhead.md).
  choices?: Record<string, Record<string, string>>;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  // The admin's starter questions when set, otherwise the passport's.
  starters: string[];
  // Its mark next to its words in the chat (spec, section 8.17), shown while «Интерфейс» allows.
  mark: AgentMark;
  // Actions of the agent and of its sub-agents by tool name; tools of connected systems appear
  // once they were listed for someone.
  actions: Record<string, ActionDescription>;
  // Which system a tool works in, for the chat line «Ищу в …»: exact tool names of plugins and
  // name prefixes of connected systems (their tools are built per employee).
  systems: { tools: Record<string, string>; prefixes: Record<string, string> };
}

export interface AgentListResponse {
  agents: AgentSummary[];
}

// Attachments of a conversation (spec, sections 7 and 8.18): what the skills read, and the size
// limit. The old .doc, .xls and .ppt are turned into the new formats by the document skills.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
// What a person may attach (spec, section 8.9; the popular formats — request of the owner 17.11): what the
// agent reads in its sandbox — documents through the skills and LibreOffice, text as it is, a mail as text,
// an archive unpacked, pictures seen (PNG and JPG at once, the rest turned into PNG first). Not audio or
// video (nothing reads them), not SVG (a picture that can run a script), not programs.
export const UPLOAD_EXTENSIONS = [
  '.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.odt', '.ods', '.odp', '.rtf',
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.yaml', '.yml', '.log', '.eml',
  '.zip',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff',
] as const;

export interface UploadedFile {
  path: string;
  name: string;
  bytes: number;
}

// The person's message names its attachments in a block after the text; the feed shows them as
// chips, and the server gives the model the pictures among them with the message.
const ATTACHMENTS_MARKER = '\n\nВложения:\n';
const ATTACHMENT_LINE = /^- (.+) \(файл в рабочей папке: (.+)\)$/;

export function withAttachments(text: string, files: Pick<UploadedFile, 'name' | 'path'>[]): string {
  if (files.length === 0) return text;
  return `${text}${ATTACHMENTS_MARKER}${files.map((f) => `- ${f.name} (файл в рабочей папке: ${f.path})`).join('\n')}`;
}

// The person's own words and the files the message brought; a text that only looks like the block
// (a line that is not a file) is the person's text as is.
export function splitAttachments(text: string): { text: string; files: Pick<UploadedFile, 'name' | 'path'>[] } {
  const at = text.lastIndexOf(ATTACHMENTS_MARKER);
  if (at < 0) return { text, files: [] };
  const lines = text.slice(at + ATTACHMENTS_MARKER.length).split('\n');
  const files = lines.map((l) => ATTACHMENT_LINE.exec(l)).filter((m): m is RegExpExecArray => m !== null).map((m) => ({ name: m[1]!, path: m[2]! }));
  return files.length === lines.length ? { text: text.slice(0, at), files } : { text, files: [] };
}

export type AttachedFile = Pick<UploadedFile, 'name' | 'path'>;

// The files of a person's message in a request to the model, and which of its text parts holds the block. Each
// text part is read on its own: what the server adds to the message — the time, the text of documents — is a
// part of its own and never breaks the block (spec, section 8.29).
export function attachmentsOf(content: string | readonly { type?: string; text?: unknown }[]): { files: AttachedFile[]; part: number } {
  if (typeof content === 'string') return { files: splitAttachments(content).files, part: 0 };
  for (const [part, p] of content.entries()) {
    if (p.type !== 'text' || typeof p.text !== 'string') continue;
    const files = splitAttachments(p.text).files;
    if (files.length > 0) return { files, part };
  }
  return { files: [], part: -1 };
}

// Events our server adds to the AG-UI stream of the chat as CUSTOM events (spec, sections 8.16 and 9.1).
export const CHAT_EVENTS = {
  // The person saw words of a model call that broke and was asked again: the message goes off the screen.
  messageDiscarded: 'bba.message_discarded',
  // On opening a conversation: its answers that broke and stayed broken.
  turnsFailed: 'bba.turns_failed',
  // The conversation got its name while the agent answered: «Недавние» load again.
  threadTitled: 'bba.thread_titled',
  // A step of the researcher of the internet, for the live block of its search (spec, section 8.30).
  webProgress: 'bba.web_progress',
} as const;

// The errand of the internet of an agent (spec, section 8.30): the chat draws its call as the live block of the search.
export const WEB_RESEARCH_TOOL = 'web_research';

// A step of the search of the internet (spec, section 8.30): a query to the search, or a page read. The same
// step comes again with its new state; `id` tells which.
export const webStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('search'), id: z.string().min(1), query: z.string(), state: z.enum(['running', 'done', 'failed']), found: z.number().int().nonnegative().optional(), code: z.string().optional() }),
  z.object({ kind: z.literal('page'), id: z.string().min(1), address: z.string(), host: z.string(), title: z.string().optional(), state: z.enum(['running', 'done', 'failed']), code: z.string().optional() }),
]);
export type WebStep = z.infer<typeof webStepSchema>;

// CUSTOM event of the chat stream: the step of the search of a call of web_research.
export const webProgressSchema = z.object({ toolCallId: z.string().min(1), step: webStepSchema });

// What web_research gives back, its steps included: the block of the search is the same after a reload.
export const webResearchResultSchema = z.object({
  answer: z.string(),
  sources: z.array(z.object({ title: z.string(), address: z.string() })),
  steps: z.array(webStepSchema),
  ms: z.number().nonnegative(),
});

export const threadTitledSchema = z.object({ threadId: z.string().min(1), title: z.string().min(1) });

// PATCH /app/api/threads/:threadId: the person names their conversation themselves (spec, section 8.16).
export const THREAD_TITLE_MAX = 100;
export const renameThreadSchema = z.object({ title: z.string().trim().min(1).max(THREAD_TITLE_MAX) });

export interface RenameThreadResponse {
  thread: { id: string; title: string };
}

// GET /app/api/threads/:threadId — the name of one's own conversation for «Переименовать» in the chat.
export type ThreadNameResponse = RenameThreadResponse;

// Without `toolCallIds` the message goes; with them only those calls go (a broken step whose first
// call hangs on the message of an earlier step) and the message stays.
export const messageDiscardedSchema = z.object({ messageId: z.string().min(1), toolCallIds: z.array(z.string().min(1)).min(1).optional() });

// Failures of an answer that sending the question again can fix (decision of the owner 15.11): the
// model did not answer or broke off, went silent, was busy, or the gateway was down. A conversation
// too long for the model, a spent limit or refused access stay as they are — their text says what to do.
export const ANSWER_AGAIN_CODES: readonly string[] = ['APP_MODEL_UNAVAILABLE', 'APP_MODEL_TIMEOUT', 'APP_MODEL_RATE_LIMITED', 'APP_MODEL_GATEWAY_UNAVAILABLE'];

export const failedTurnsSchema = z.object({
  // Answers that broke, as they are on the screen («Ответ прервался» under them).
  interruptedMessageIds: z.array(z.string()),
  // The last answer of the conversation broke: what happened, in our code and words. «Ответить
  // заново» is offered only when a repeat helps and no action ran after «Да» in that turn
  // (`actionDone`: it would be asked for again — decision of the owner 15.11).
  last: z.object({ code: z.string(), message: z.string(), answerAgain: z.boolean(), actionDone: z.boolean() }).nullable(),
});
export type FailedTurns = z.infer<typeof failedTurnsSchema>;

// POST /app/api/threads/:threadId/retry: the question the person sees under the broken answer — only
// that turn is taken out, so a second click never reaches an earlier one.
export const retryTurnSchema = z.object({ questionId: z.string().min(1) });

// The question, taken out of the conversation together with its broken answer, to be sent again as
// it was (attachments included).
export interface RetryTurnResponse {
  text: string;
}

export interface ThreadSummaryDto {
  id: string;
  title: string;
  kind: 'chat' | 'background' | 'draft';
  unread: boolean;
  updatedAt: string;
  agentId: string;
  projectId: string | null;
}

// GET /app/api/threads: conversations of all the person's agents, newest first; `next` is the
// cursor for the following page (null on the last one).
export interface ThreadPage {
  threads: ThreadSummaryDto[];
  next: string | null;
}

// GET /app/api/search (spec, sections 8.13, 8.20 and 8.21): projects the person sees, their own
// conversations and the documents of their folder and of the projects they see.
export const SEARCH_SCOPES = ['all', 'threads', 'projects', 'files'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

// What the search finds by name among files (decision of the owner 16.11): documents, without pictures
// and the working files of the agent.
export const DOCUMENT_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.csv', '.txt'] as const;

// What of a text the search found (spec, section 8.21): [start, end) in UTF-16 units of that very text, in
// order and apart; the window marks them. Empty where nothing is marked (the lists before a query).
export type TextMarks = [number, number][];

export interface SearchFile {
  // From the files folder of the project, or of the person's conversations outside projects (projectId null).
  path: string;
  name: string;
  nameMarks: TextMarks;
  projectId: string | null;
  // The conversation outside projects whose folder (`chats/<id>/`) the file lies in (spec, section 8.33); its title is
  // null when the conversation is gone. Null for a file of a project.
  conversation: { id: string; title: string | null } | null;
  modifiedAt: string;
  bytes: number;
}

// GET /app/api/search/files gives the newest; the search, those found. `unreadable` — folders the server
// could not read (the project's name, null for the person's own folder); `more` — more than shown.
export interface SearchFiles {
  files: SearchFile[];
  unreadable: { projectId: string | null; name: string | null }[];
  more: boolean;
}

export interface SearchResponse {
  projects: { id: string; name: string; nameMarks: TextMarks; threadCount: number; shared: boolean; ownerName: string | null }[];
  threads: { id: string; agentId: string; title: string; titleMarks: TextMarks; snippet: string; snippetMarks: TextMarks; projectId: string | null; updatedAt: string }[];
  files: SearchFiles;
}

// Result of a tool call the person declined (or cancelled by writing a new message instead of
// answering, or left unanswered until its question burnt): the server puts it into the chat stream and the history,
// the chat shows «отменено» or «Вопрос истёк: вы не ответили за N ч».
export interface DeclinedToolResult {
  declined: true;
  superseded: boolean;
  // The term of a question that burnt unanswered (docs/specs/[20.11.2026]-notifications.md, F4); null otherwise.
  expiredHours: number | null;
}
