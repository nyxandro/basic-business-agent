// Agents open to the person (GET /app/api/agents): what the chat list shows on its cards.
export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  starters: string[];
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
