// The agent's workspace per employee (spec, section 8.7; verified at step 0, V1 and V6): the
// conversation's files folder (core/workspace/layout.ts) is the root of both the file tools and the
// bubblewrap sandbox — no network, no app environment; the folders of the skills this employee
// gets (and only those, V14) and the Python of the skills are visible read-only.
import { splitAttachments, type ActionDescription } from '@bba/contracts';
import { createHash } from 'node:crypto';
import { closeSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { Processor } from '@mastra/core/processors';
import { createTool } from '@mastra/core/tools';
import { LocalFilesystem, LocalSandbox, Workspace, WORKSPACE_TOOLS, type WorkspaceToolHookContext } from '@mastra/core/workspace';
import { z } from 'zod';
import { isAppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import { logEvent } from '../server/log.ts';
import type { AnyTool } from '../plugins/public/index.ts';
import { optionalContextValue, REQUEST_KEYS, requireContextValue, skillPathsOf } from '../runtime/request-keys.ts';
import { keepBeforeWrite } from '../projects/trash.ts';
import { contextRoot, existingInside, openFileInside } from '../workspace/layout.ts';
import { sandboxOptions } from './environment.ts';
import type { Limiter } from './limiter.ts';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
export const VIEW_IMAGE_TOOL = 'view_image';
// The chat-completions protocol of the gateway carries no images inside tool results: a picture or
// raw bytes read by Mastra's read_file would go to the model as text and overflow its window.
const RAW_ENCODINGS = new Set(['base64', 'binary', 'hex']);
const NO_PICTURE_IN_READ_FILE = 'Это картинка: её содержимое через чтение файла не передаётся. Чтобы увидеть её, вызови view_image с этим путём.';
const NO_RAW_BYTES = 'Сырые байты файла в разговор не передаются. Картинку открой через view_image; PDF, Word, Excel и PowerPoint читай скиллами pdf, docx, xlsx и pptx.';

// How the chat line names the tools the workspace and the skills give every agent (Mastra's own
// names would show as mastra_workspace_read_file).
const ACTION_TITLES: [name: string, title: string, readOnly: boolean][] = [
  [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE, 'Чтение файла', true],
  [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE, 'Запись файла', false],
  [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE, 'Правка файла', false],
  [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES, 'Список файлов', true],
  [WORKSPACE_TOOLS.FILESYSTEM.DELETE, 'Удаление файла', false],
  [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT, 'Сведения о файле', true],
  [WORKSPACE_TOOLS.FILESYSTEM.MKDIR, 'Новая папка', false],
  [WORKSPACE_TOOLS.FILESYSTEM.GREP, 'Поиск в файлах', true],
  [WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT, 'Правка кода', false],
  [WORKSPACE_TOOLS.FILESYSTEM.APPLY_PATCH, 'Правка файлов', false],
  [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND, 'Команда в рабочей папке', false],
  [WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT, 'Вывод команды', true],
  [WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS, 'Остановка команды', false],
  [WORKSPACE_TOOLS.SEARCH.SEARCH, 'Поиск по файлам', true],
  [WORKSPACE_TOOLS.SEARCH.INDEX, 'Указатель файлов', false],
  ['skill', 'Активация навыка', true],
  ['skill_read', 'Чтение навыка', true],
  ['skill_search', 'Поиск в навыках', true],
  [VIEW_IMAGE_TOOL, 'Просмотр картинки', true],
];
export const WORKSPACE_ACTIONS: Record<string, ActionDescription> = Object.fromEntries(ACTION_TITLES.map(([name, title, readOnly]) => [name, { title, fields: {}, readOnly }]));

export interface SandboxDeps {
  workspaceRoot: string;
  skillsVenv: string;
  limiter: Limiter;
}

type Ctx = { get(key: string): unknown } | undefined;

// The files folder of the run: the project's when the conversation is in one — it lives with the
// project's creator, who may be someone else (spec, section 8.20) — otherwise the person's.
export function runRoot(workspaceRoot: string, ctx: Ctx): string {
  const projectId = optionalContextValue(ctx, REQUEST_KEYS.projectId);
  if (projectId) return contextRoot(workspaceRoot, requireContextValue(ctx, REQUEST_KEYS.projectOwnerId), projectId);
  return contextRoot(workspaceRoot, requireContextValue(ctx, REQUEST_KEYS.userId), null);
}

// Isolation is required: without it a skill script could reach the server (spec, anti-goals).
export function assertIsolationAvailable(): 'bwrap' | 'seatbelt' {
  const detected = LocalSandbox.detectIsolation() as { backend: 'none' | 'bwrap' | 'seatbelt'; available: boolean; message: string };
  if (!detected.available || detected.backend === 'none') {
    throw appError('APP_SANDBOX_UNAVAILABLE', `no OS isolation for the sandbox: ${detected.message}`);
  }
  return detected.backend;
}

// LocalSandbox defines executeCommand as an instance field, so the limit wraps the instance.
function limitedSandbox(options: ConstructorParameters<typeof LocalSandbox>[0], limiter: Limiter): LocalSandbox {
  const sandbox = new LocalSandbox(options);
  const original = sandbox.executeCommand!.bind(sandbox);
  sandbox.executeCommand = (...args) => limiter.run(() => original(...args));
  return sandbox;
}

export function createAgentWorkspace(deps: SandboxDeps, isolation: 'bwrap' | 'seatbelt'): Workspace {
  const dirOf = (ctx: Ctx) => runRoot(deps.workspaceRoot, ctx);
  return new Workspace({
    filesystem: ({ requestContext }) => new LocalFilesystem({ basePath: dirOf(requestContext), allowedPaths: skillPathsOf(requestContext) }),
    sandbox: ({ requestContext }) => {
      const dir = dirOf(requestContext);
      return limitedSandbox(sandboxOptions(deps.skillsVenv, dir, skillPathsOf(requestContext), isolation), deps.limiter);
    },
    // A cached sandbox keeps the folders it was made with, so another set of skills is another sandbox.
    sandboxCacheKey: ({ requestContext }) =>
      `${requireContextValue(requestContext, REQUEST_KEYS.userId)}:${optionalContextValue(requestContext, REQUEST_KEYS.projectId) ?? ''}:${createHash('sha256').update(requireContextValue(requestContext, REQUEST_KEYS.skillPaths)).digest('hex').slice(0, 16)}`,
    skills: ({ requestContext }) => skillPathsOf(requestContext),
    tools: {
      // Without media parts a picture or a PDF read with read_file is only described, not sent.
      [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: { mediaTypes: false },
      hooks: { beforeToolCall: (ctx) => keepBytesOutOfReadFile(ctx) ?? keepPreviousVersion(deps.workspaceRoot, ctx) },
    },
  });
}

// The agent's own tools write a file in place: in a project, the file as it was before this answer
// is copied into the answer's snapshot first, so its previous version reaches the trash (spec, 8.20).
const PATCH_FILE = /^\*\*\* (?:Update|Delete) File: (.+)$/gm;

function pathsWritten(tool: string, input: unknown): string[] {
  const { path, patch } = (input ?? {}) as { path?: unknown; patch?: unknown };
  if ([WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE, WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE, WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT].includes(tool as never)) return typeof path === 'string' ? [path] : [];
  if (tool === WORKSPACE_TOOLS.FILESYSTEM.APPLY_PATCH && typeof patch === 'string') return [...patch.matchAll(PATCH_FILE)].map((m) => m[1]!.trim());
  return [];
}

function keepPreviousVersion(workspaceRoot: string, { workspaceToolName, input, context }: WorkspaceToolHookContext): undefined {
  const paths = pathsWritten(workspaceToolName, input);
  if (paths.length === 0) return undefined;
  const ctx = (context as { requestContext?: Ctx } | undefined)?.requestContext;
  const id = optionalContextValue(ctx, REQUEST_KEYS.projectSnapshot);
  const projectId = optionalContextValue(ctx, REQUEST_KEYS.projectId);
  const ownerId = optionalContextValue(ctx, REQUEST_KEYS.projectOwnerId);
  if (id && projectId && ownerId) keepBeforeWrite(workspaceRoot, { id, projectId, ownerId }, paths);
  return undefined;
}

function keepBytesOutOfReadFile({ workspaceToolName, input }: WorkspaceToolHookContext): void | { proceed: false; output: string } {
  if (workspaceToolName !== WORKSPACE_TOOLS.FILESYSTEM.READ_FILE) return;
  const { path, encoding } = (input ?? {}) as { path?: unknown; encoding?: unknown };
  if (typeof encoding === 'string' && RAW_ENCODINGS.has(encoding)) return { proceed: false, output: NO_RAW_BYTES };
  if (typeof path === 'string' && IMAGE_TYPES[extname(path).toLowerCase()]) return { proceed: false, output: NO_PICTURE_IN_READ_FILE };
}

// A core tool: shows the model an image from the employee's folder (a scanned page, a photo).
export function createViewImageTool(workspaceRoot: string): AnyTool {
  return createTool({
    id: VIEW_IMAGE_TOOL,
    description: 'Посмотреть картинку из рабочей папки сотрудника (PNG или JPG): отрисованную страницу скана, фото документа.',
    inputSchema: z.object({ path: z.string().min(1).describe('Путь от рабочей папки или абсолютный путь внутри неё, например .renders/dogovor-p3.png') }),
    execute: ({ path }, context) => {
      const picture = findPicture(runRoot(workspaceRoot, context?.requestContext), path);
      return Promise.resolve(typeof picture === 'string' ? { ok: false, error: picture } : { ok: true, path, mediaType: picture.mediaType });
    },
  }) as AnyTool;
}

interface ViewResult {
  ok?: boolean;
  path?: string;
  mediaType?: string;
}

type PromptMessage = { role: string; content: unknown };
type FilePart = { type: 'file'; data: string; mediaType: string };

// A picture of the employee's folder, or why there is none. Only a file inside the folder: the server
// reads it outside the sandbox, so a link the agent made to a file of the server is refused.
function findPicture(dir: string, path: string): { real: string; mediaType: string } | string {
  const mediaType = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!mediaType) return 'Это не PNG или JPG';
  let real: string | null;
  try {
    real = existingInside(dir, path);
  } catch (error) {
    if (!isAppError(error)) throw error;
    return `Путь ${path} ведёт за пределы рабочей папки`;
  }
  if (!real || !statSync(real).isFile()) return `Файла ${path} нет`;
  if (statSync(real).size > MAX_IMAGE_BYTES) return 'Картинка больше 5 МБ';
  return { real, mediaType };
}

// The picture as a part of a model message, or why it cannot be one. Read from the file opened and
// checked once (a link swapped in after the check is not followed).
function pictureOf(dir: string, path: string): FilePart | string {
  const picture = findPicture(dir, path);
  if (typeof picture === 'string') return picture;
  let file: { fd: number; size: number } | null;
  try {
    file = openFileInside(dir, path);
  } catch (error) {
    if (!isAppError(error)) throw error;
    return `Путь ${path} ведёт за пределы рабочей папки`;
  }
  if (!file) return `Файла ${path} нет`;
  try {
    if (file.size > MAX_IMAGE_BYTES) return 'Картинка больше 5 МБ';
    return { type: 'file', data: readFileSync(file.fd).toString('base64'), mediaType: picture.mediaType };
  } finally {
    closeSync(file.fd);
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((p: { type?: string; text?: unknown }) => (p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('') : '';
}

// The pictures attached to the person's latest message go to the model with that message, so
// «что на картинке?» needs no tool call. Requests are built anew for every step of a run, so this
// adds them to each step; earlier messages' pictures are not sent again (view_image opens them).
function withAttachedPictures(prompt: PromptMessage[], dir: string): PromptMessage[] | undefined {
  const at = prompt.findLastIndex((m) => m.role === 'user');
  if (at < 0) return undefined;
  const pictures = splitAttachments(textOf(prompt[at]!.content)).files.filter((f) => IMAGE_TYPES[extname(f.path).toLowerCase()]);
  if (pictures.length === 0) return undefined;
  const parts = pictures.map((f) => pictureOf(dir, f.path));
  for (const part of parts) if (typeof part === 'string') logEvent('warn', 'attached_picture_not_sent', { reason: part });
  const content = typeof prompt[at]!.content === 'string' ? [{ type: 'text', text: prompt[at]!.content }] : (prompt[at]!.content as unknown[]);
  const sent = parts.filter((p): p is FilePart => typeof p !== 'string');
  return prompt.map((m, i) => (i === at ? { ...m, content: [...content, ...sent] } : m));
}

// The chat-completions protocol carries no images inside tool results, so the image of every
// view_image call made in this run goes to the model as a following user message (transient:
// stored history keeps only the tool result, earlier runs' images are not re-sent). Pictures
// attached to the person's message go with that message.
export function createImageViewProcessor(workspaceRoot: string) {
  return {
    id: 'bba-image-view',
    processLLMRequest({ prompt, steps, requestContext }) {
      const dir = runRoot(workspaceRoot, requestContext);
      const withAttached = withAttachedPictures(prompt, dir);
      const shown = steps
        .flatMap((s) => (s.toolResults ?? []) as { toolName?: string; output?: { type?: string; value?: unknown } }[])
        .filter((r) => r.toolName === VIEW_IMAGE_TOOL)
        // Step results carry the model-facing form: { type: 'json', value: <tool result> }.
        .map((r) => (r.output?.type === 'json' ? r.output.value : r.output) as ViewResult)
        .filter((r) => r?.ok && r.path && r.mediaType);
      if (shown.length === 0) return withAttached ? { prompt: withAttached as typeof prompt } : undefined;
      // Checked again: the file could have changed since the call (e.g. into a link out of the folder).
      const parts = shown.flatMap((r) => {
        const picture = pictureOf(dir, r.path!);
        if (typeof picture === 'string') {
          logEvent('warn', 'viewed_picture_not_sent', { reason: picture });
          return [];
        }
        return [{ type: 'text' as const, text: `Картинка ${r.path}:` }, picture];
      });
      // Every picture gone (a skill rendered the page anew): an empty user message is refused by
      // providers such as Groq and would end the whole answer.
      if (parts.length === 0) return withAttached ? { prompt: withAttached as typeof prompt } : undefined;
      return { prompt: [...((withAttached ?? prompt) as typeof prompt), { role: 'user' as const, content: parts }] };
    },
  } satisfies Processor;
}
