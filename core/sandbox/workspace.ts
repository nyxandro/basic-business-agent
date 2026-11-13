// The agent's workspace per employee (spec, section 8.7; verified at step 0, V1 and V6):
// files in /workspace/<userId>, commands in a bubblewrap sandbox without network and without the
// app's environment; skill folders and the Python of the skills are visible read-only.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import type { Processor } from '@mastra/core/processors';
import { createTool } from '@mastra/core/tools';
import { LocalFilesystem, LocalSandbox, Workspace } from '@mastra/core/workspace';
import { z } from 'zod';
import { appError } from '../errors/catalog.ts';
import type { AgentRuntime } from '../loader/registry.ts';
import type { AnyTool } from '../plugins/public/index.ts';
import { REQUEST_KEYS, requireContextValue } from '../runtime/request-keys.ts';
import type { Limiter } from './limiter.ts';

export const COMMAND_TIMEOUT_MS = 120_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const VIEW_IMAGE_TOOL = 'view_image';

export interface SandboxDeps {
  workspaceRoot: string;
  skillsVenv: string;
  limiter: Limiter;
}

type Ctx = { get(key: string): unknown } | undefined;

export function userDir(workspaceRoot: string, userId: string): string {
  if (!SAFE_USER_ID.test(userId)) throw new Error(`unsafe user id for a workspace path: ${userId}`);
  const dir = join(workspaceRoot, userId);
  mkdirSync(dir, { recursive: true });
  return dir;
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

export function createAgentWorkspace(rt: AgentRuntime, deps: SandboxDeps, isolation: 'bwrap' | 'seatbelt'): Workspace {
  const dirOf = (ctx: Ctx) => userDir(deps.workspaceRoot, requireContextValue(ctx, REQUEST_KEYS.userId));
  const readOnlyPaths = [...rt.skillDirs, deps.skillsVenv].filter((p) => existsSync(p));
  return new Workspace({
    filesystem: ({ requestContext }) => new LocalFilesystem({ basePath: dirOf(requestContext), allowedPaths: rt.skillDirs }),
    sandbox: ({ requestContext }) => {
      const dir = dirOf(requestContext);
      return limitedSandbox(
        {
          workingDirectory: dir,
          isolation,
          timeout: COMMAND_TIMEOUT_MS,
          nativeSandbox: { allowNetwork: false, readOnlyPaths },
          // Nothing from the app's environment (secrets) reaches the scripts.
          env: { PATH: `${join(deps.skillsVenv, 'bin')}:/usr/local/bin:/usr/bin:/bin`, HOME: dir, LANG: 'C.UTF-8', PYTHONIOENCODING: 'utf-8' },
        },
        deps.limiter,
      );
    },
    sandboxCacheKey: ({ requestContext }) => requireContextValue(requestContext, REQUEST_KEYS.userId),
    ...(rt.skillDirs.length > 0 ? { skills: rt.skillDirs } : {}),
  });
}

function resolveInside(dir: string, path: string): string {
  const full = resolve(dir, path);
  if (relative(dir, full).startsWith('..')) throw appError('APP_VALIDATION_FAILED', `path ${path} is outside the workspace`);
  return full;
}

// A core tool: shows the model an image from the employee's folder (a scanned page, a photo).
export function createViewImageTool(workspaceRoot: string): AnyTool {
  return createTool({
    id: VIEW_IMAGE_TOOL,
    description: 'Посмотреть картинку из рабочей папки сотрудника (PNG или JPG): отрисованную страницу скана, фото документа.',
    inputSchema: z.object({ path: z.string().min(1).describe('Путь от рабочей папки, например renders/dogovor-p3.png') }),
    execute: ({ path }, context) => {
      const full = resolveInside(userDir(workspaceRoot, requireContextValue(context?.requestContext, REQUEST_KEYS.userId)), path);
      const mediaType = IMAGE_TYPES[extname(full).toLowerCase()];
      if (!mediaType) return Promise.resolve({ ok: false, error: 'Это не PNG или JPG' });
      if (!existsSync(full)) return Promise.resolve({ ok: false, error: `Файла ${path} нет` });
      if (statSync(full).size > MAX_IMAGE_BYTES) return Promise.resolve({ ok: false, error: 'Картинка больше 5 МБ' });
      return Promise.resolve({ ok: true, path, mediaType });
    },
  }) as AnyTool;
}

interface ViewResult {
  ok?: boolean;
  path?: string;
  mediaType?: string;
}

// The chat-completions protocol carries no images inside tool results, so the image of every
// view_image call made in this run goes to the model as a following user message (transient:
// stored history keeps only the tool result, earlier runs' images are not re-sent).
export function createImageViewProcessor(workspaceRoot: string) {
  return {
    id: 'bba-image-view',
    processLLMRequest({ prompt, steps, requestContext }) {
      const shown = steps
        .flatMap((s) => (s.toolResults ?? []) as { toolName?: string; output?: { type?: string; value?: unknown } }[])
        .filter((r) => r.toolName === VIEW_IMAGE_TOOL)
        // Step results carry the model-facing form: { type: 'json', value: <tool result> }.
        .map((r) => (r.output?.type === 'json' ? r.output.value : r.output) as ViewResult)
        .filter((r) => r?.ok && r.path && r.mediaType);
      if (shown.length === 0) return undefined;
      const dir = userDir(workspaceRoot, requireContextValue(requestContext, REQUEST_KEYS.userId));
      const parts = shown.flatMap((r) => [
        { type: 'text' as const, text: `Картинка ${r.path}:` },
        { type: 'file' as const, data: readFileSync(resolveInside(dir, r.path!)).toString('base64'), mediaType: r.mediaType! },
      ]);
      return { prompt: [...prompt, { role: 'user' as const, content: parts }] };
    },
  } satisfies Processor;
}
