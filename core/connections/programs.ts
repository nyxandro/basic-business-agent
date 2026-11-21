// Program servers of MCP from the app's side (docs/specs/[20.11.2026]-mcp-connections.md, F1, step 9): the request of
// the program to mcp-runner — the admin's package and arguments, the environment filled with the shared key — and its
// preparation when the admin checks the server (the package is installed once, the program started).
import type { McpField, McpProgram } from '@bba/contracts';
import { appError } from '../errors/catalog.ts';
import { runnerPath, signedHeaders, type ProgramSpec } from '../mcp-runner/protocol.ts';
import { isNetworkFailure, safeCause } from './log-safe.ts';
import { fillTemplate } from './templates.ts';

// Where mcp-runner is and the secret of its requests; null — the installation has no container of programs.
export interface RunnerAccess {
  url: string;
  secret: string;
}

// Installing a package may take minutes; a started program answers at once.
const PREPARE_TIMEOUT_MS = 5 * 60 * 1000;

// Why a package did not install, for the admin (mcp-runner says it in a word).
const PACKAGE_REASONS: Record<string, string> = {
  not_found: 'такого пакета или такой версии нет',
  no_wheel: 'у пакета нет готовой сборки, а собирать его на сервере нельзя',
  no_bin: 'в пакете нет программы для запуска',
  network: 'хранилище пакетов не ответило',
};

export const runnerNotConfigured = () => appError('APP_MCP_RUNNER_NOT_CONFIGURED', 'mcp-runner is not configured (MCP_RUNNER_URL, MCP_RUNNER_SECRET)');

export function requireRunner(runner: RunnerAccess | null): RunnerAccess {
  if (!runner) throw runnerNotConfigured();
  return runner;
}

// The environment is only what the admin's templates make of the shared key: nothing else reaches the program.
export function programSpecOf(program: McpProgram, envTemplates: Record<string, string>, fields: readonly McpField[], shared: Record<string, string> | null): ProgramSpec {
  const env = Object.fromEntries(
    Object.entries(envTemplates).map(([name, template]) => [
      name,
      fillTemplate(template, (key) => {
        const value = shared?.[key];
        if (!value || !fields.some((f) => f.key === key)) throw appError('APP_INTERNAL', `program env ${name} names ${key} without a shared value`);
        return value;
      }),
    ]),
  );
  return { runner: program.runner, package: program.package, args: program.args, env };
}

export const programUrl = (runner: RunnerAccess, serverId: string) => new URL(runnerPath(serverId, 'mcp'), runner.url);

// The signed request of every call: the signature is fresh, mcp-runner refuses one older than a few minutes.
export function signedFetch(runner: RunnerAccess, serverId: string, spec: ProgramSpec) {
  return (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(signedHeaders(runner.secret, serverId, spec))) headers.set(name, value);
    return fetch(url, { ...init, headers });
  };
}

// «Проверить своим доступом» of a program: the package installed, the program started and answering by MCP.
export async function prepareProgram(runner: RunnerAccess, serverId: string, spec: ProgramSpec): Promise<void> {
  let response: Response;
  try {
    response = await signedFetch(runner, serverId, spec)(new URL(runnerPath(serverId, 'prepare'), runner.url), { method: 'POST', signal: AbortSignal.timeout(PREPARE_TIMEOUT_MS) });
  } catch (error) {
    if (isNetworkFailure(error)) throw appError('APP_MCP_UNREACHABLE', 'mcp-runner does not answer', { cause: safeCause(error), userMessage: 'Контейнер программ-серверов не отвечает. Попробуйте через минуту; если повторяется — сообщите тому, кто ставил установку.' });
    throw error;
  }
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  const code = body?.error?.code;
  if (code === 'APP_MCP_PACKAGE_FAILED') {
    const reason = PACKAGE_REASONS[body?.error?.message ?? ''] ?? PACKAGE_REASONS.network!;
    throw appError('APP_MCP_PACKAGE_FAILED', `package ${spec.package} failed: ${body?.error?.message ?? 'unknown'}`, {
      userMessage: `Не удалось скачать пакет ${spec.package}: ${reason}. Проверьте название и версию.`,
    });
  }
  if (code === 'APP_MCP_NOT_MCP') {
    throw appError('APP_MCP_NOT_MCP', `program ${spec.package} does not answer by MCP`, { userMessage: 'Программа запустилась, но не отвечает как сервер MCP. Проверьте команду и аргументы по инструкции системы.' });
  }
  throw appError('APP_MCP_UNREACHABLE', `mcp-runner answered ${response.status} ${code ?? ''}`);
}
