// The Mastra instance of the installation: agents from the registry, Postgres storage in schema
// `mastra`, and Mastra Editor for prompt edits over the files.
import { Mastra } from '@mastra/core';
import type { Agent } from '@mastra/core/agent';
import { MastraEditor } from '@mastra/editor';
import type { Memory } from '@mastra/memory';
import type { PostgresStore } from '@mastra/pg';
import type { AppConfig } from '../config/schemas.ts';
import type { ConnectionManager } from '../connections/manager.ts';
import type { Db } from '../db/pool.ts';
import type { Registry } from '../loader/registry.ts';
import { createMaskingProcessor } from '../masking/processor.ts';
import { agentActions } from '../approvals/describe.ts';
import { createApprovalRecorder } from '../approvals/requests.ts';
import type { ModelGateway } from '../models/gateway.ts';
import { createPromptLayersProcessor } from '../prompts/layers.ts';
import { createImageViewProcessor, type SandboxDeps } from '../sandbox/workspace.ts';
import { createMastraAgent, FALLBACK_FIRST_CHUNK_MS } from './agent-factory.ts';

export interface MastraRuntimeDeps {
  registry: Registry;
  storage: PostgresStore;
  memory: Memory;
  gateway: Pick<ModelGateway, 'modelConfig'>;
  db: Db;
  app: Pick<AppConfig, 'timezone'>;
  // Root of the employees' workspaces: the project layer of the prompt lists the project's files.
  workspaceRoot: string;
  // FALLBACK_FIRST_CHUNK_MS unless a test shortens it.
  firstChunkMs?: number;
  connections?: Pick<ConnectionManager, 'toolsFor' | 'actionsSeen'>;
  sandbox?: { deps: SandboxDeps; isolation: 'bwrap' | 'seatbelt' };
  // Mastra workflows of the core, e.g. "background-run" for background tasks.
  workflows?: ConstructorParameters<typeof Mastra>[0] extends infer O ? (O extends { workflows?: infer W } ? W : never) : never;
}

export function createMastraRuntime(deps: MastraRuntimeDeps): Mastra {
  const masking = createMaskingProcessor(deps.db);
  const memory = deps.memory;
  const imageView = deps.sandbox ? [createImageViewProcessor(deps.sandbox.deps.workspaceRoot)] : [];
  const agents: Record<string, Agent> = {};
  // Questions keep the name of the action: the agent's own tools, else a connected system's.
  const recorderOf = (rt: (typeof deps.registry.agents)[number]) => {
    const own = agentActions(rt);
    return createApprovalRecorder(deps.db, (tool) => own[tool] ?? deps.connections?.actionsSeen()[tool] ?? null);
  };
  for (const rt of deps.registry.agents) {
    agents[rt.passport.id] = createMastraAgent(rt, {
      gateway: deps.gateway,
      firstChunkMs: deps.firstChunkMs ?? FALLBACK_FIRST_CHUNK_MS,
      memory,
      ...(deps.connections ? { connections: deps.connections } : {}),
      ...(deps.sandbox ? { sandbox: deps.sandbox } : {}),
      processorsFor: (r, level) => ({
        input: [
          createPromptLayersProcessor({ db: deps.db, timezone: deps.app.timezone, baseRules: r.passport.baseRules !== false, workspaceRoot: deps.workspaceRoot }),
          masking,
          ...imageView,
        ],
        // A sub-agent's request for "Да" reaches the parent's stream too: it is recorded there once,
        // under the run id the chat answers to.
        output: level === 'top' ? [masking, recorderOf(r)] : [masking],
      }),
    });
  }
  return new Mastra({ agents, storage: deps.storage, editor: new MastraEditor(), ...(deps.workflows ? { workflows: deps.workflows } : {}) });
}
