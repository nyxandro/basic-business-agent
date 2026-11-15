import { z } from 'zod';

// Agents open to the person (GET /app/api/agents): what the chat list shows on its cards.
// What the confirmation card shows: the name of the action and the labels of its fields, taken
// from the tool's own description (spec, section 8.4).
export interface ActionDescription {
  title: string;
  fields: Record<string, string>;
  // Reads only: works without «Да» («только чтение» in the chat).
  readOnly: boolean;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  // The admin's starter questions when set, otherwise the passport's.
  starters: string[];
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

// Attachments of a conversation (spec, section 7): what the skills read, and the size limit.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const UPLOAD_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.csv', '.txt', '.png', '.jpg', '.jpeg'] as const;

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

// Events our server adds to the AG-UI stream of the chat as CUSTOM events (spec, section 9.1).
export const CHAT_EVENTS = {
  // The person saw words of a model call that broke and was asked again: the message goes off the screen.
  messageDiscarded: 'bba.message_discarded',
  // On opening a conversation: its answers that broke and stayed broken.
  turnsFailed: 'bba.turns_failed',
} as const;

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

// A person's project (spec, section 8.12): a folder of conversations with instructions and files.
export interface ProjectDto {
  id: string;
  name: string;
  instructions: string;
  threadCount: number;
  createdAt: string;
}

// GET /app/api/search (spec, section 8.13): the person's own projects and conversations.
export const SEARCH_SCOPES = ['all', 'threads', 'projects'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export interface SearchResponse {
  projects: { id: string; name: string; threadCount: number }[];
  threads: { id: string; agentId: string; title: string; snippet: string; projectId: string | null; updatedAt: string }[];
}

export interface ProjectFile {
  path: string;
  bytes: number;
}

// Result of a tool call the person declined (or cancelled by writing a new message instead of
// answering): the server puts it into the chat stream and the history, the chat shows «отменено».
export interface DeclinedToolResult {
  declined: true;
  superseded: boolean;
}
