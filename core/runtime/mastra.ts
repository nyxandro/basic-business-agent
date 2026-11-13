// The Mastra instance of the installation: agents from the registry, Postgres storage in schema
// `mastra`, and Mastra Editor for prompt edits over the files.
import { Mastra } from '@mastra/core';
import type { Agent } from '@mastra/core/agent';
import { MastraEditor } from '@mastra/editor';
import type { PostgresStore } from '@mastra/pg';
import type { AppConfig } from '../config/schemas.ts';
import type { ConnectionManager } from '../connections/manager.ts';
import type { Db } from '../db/pool.ts';
import type { Registry } from '../loader/registry.ts';
import { createMaskingProcessor } from '../masking/processor.ts';
import { createMemory } from '../memory/memory.ts';
import type { ModelGateway } from '../models/gateway.ts';
import { createPromptLayersProcessor } from '../prompts/layers.ts';
import { createImageViewProcessor, type SandboxDeps } from '../sandbox/workspace.ts';
import { createMastraAgent } from './agent-factory.ts';

export interface MastraRuntimeDeps {
  registry: Registry;
  storage: PostgresStore;
  gateway: Pick<ModelGateway, 'modelConfig'>;
  db: Db;
  app: Pick<AppConfig, 'name' | 'timezone'>;
  connections?: Pick<ConnectionManager, 'toolsFor'>;
  sandbox?: { deps: SandboxDeps; isolation: 'bwrap' | 'seatbelt' };
}

export function createMastraRuntime(deps: MastraRuntimeDeps): Mastra {
  const masking = createMaskingProcessor(deps.db);
  const memory = createMemory(deps.storage);
  const imageView = deps.sandbox ? [createImageViewProcessor(deps.sandbox.deps.workspaceRoot)] : [];
  const agents: Record<string, Agent> = {};
  for (const rt of deps.registry.agents) {
    agents[rt.passport.id] = createMastraAgent(rt, {
      gateway: deps.gateway,
      memory,
      ...(deps.connections ? { connections: deps.connections } : {}),
      ...(deps.sandbox ? { sandbox: deps.sandbox } : {}),
      processorsFor: (r) => ({
        input: [
          createPromptLayersProcessor({ db: deps.db, organisationName: deps.app.name, timezone: deps.app.timezone, baseRules: r.passport.baseRules !== false }),
          masking,
          ...imageView,
        ],
        output: [masking],
      }),
    });
  }
  return new Mastra({ agents, storage: deps.storage, editor: new MastraEditor() });
}
