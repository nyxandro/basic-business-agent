// The Mastra instance of the installation: agents from the registry, Postgres storage in schema
// `mastra`, and Mastra Editor for prompt edits over the files.
import { Mastra } from '@mastra/core';
import type { Agent } from '@mastra/core/agent';
import { MastraEditor } from '@mastra/editor';
import type { Memory } from '@mastra/memory';
import { createMemoryTools } from '../memory/tools.ts';
import { createHistoryTools } from '../history/tool.ts';
import type { PostgresStore } from '@mastra/pg';
import type { AppConfig } from '../config/schemas.ts';
import type { ConnectionManager } from '../connections/manager.ts';
import type { Db } from '../db/pool.ts';
import type { Registry } from '../loader/registry.ts';
import { createMaskingProcessor } from '../masking/processor.ts';
import { agentActions, describeTools } from '../approvals/describe.ts';
import { createMailTools } from '../mail/tools.ts';
import type { MailService } from '../mail/service.ts';
import { createApprovalRecorder } from '../approvals/requests.ts';
import type { ModelGateway } from '../models/gateway.ts';
import { createDocTextProcessor } from '../doctext/excerpt.ts';
import type { DocTextService } from '../doctext/service.ts';
import { createPromptLayersProcessor } from '../prompts/layers.ts';
import { createImageViewProcessor, type SandboxDeps } from '../sandbox/workspace.ts';
import { createMastraAgent, FALLBACK_FIRST_CHUNK_MS, MODEL_CALL_MAX_MS } from './agent-factory.ts';
import type { FileStorage } from '../storage/engine.ts';
import { createStreamRetry } from './stream-retry.ts';
import { createWebTools, type WebDeps } from '../web/research.ts';
import { createWidgetHistoryProcessor } from '../widgets/history.ts';
import { createOrgDocsPromptProcessor } from '../org-docs/prompt.ts';
import { createSignTools, signActionsFor, type SignDeps } from '../org-docs/sign-tool.ts';
import { SIGN_TOOL } from '../org-docs/prompt.ts';

export interface MastraRuntimeDeps {
  registry: Registry;
  storage: PostgresStore;
  memory: Memory;
  gateway: Pick<ModelGateway, 'modelConfig'>;
  db: Db;
  app: Pick<AppConfig, 'timezone'>;
  // Root of the employees' workspaces: the project layer of the prompt lists the project's files.
  workspaceRoot: string;
  // Where the files of an area are while a tool reads it (a file taken from a past conversation, spec 8.33).
  files: Pick<FileStorage, 'hold'>;
  // FALLBACK_FIRST_CHUNK_MS unless a test shortens it.
  firstChunkMs?: number;
  // MODEL_CALL_MAX_MS unless a test shortens it.
  stepMs?: number;
  connections?: Pick<ConnectionManager, 'toolsFor' | 'actionsSeen'>;
  sandbox?: { deps: SandboxDeps; isolation: 'bwrap' | 'seatbelt' };
  // The text of attached documents for the model (spec, section 8.29).
  docText: DocTextService;
  // Where the letterhead and the logo are laid out for agents (docs/specs/[20.11.2026]-org-letterhead.md).
  orgFilesDir: string;
  // The one-off sandbox that puts the stamp and the signature; without it nobody has the signing tool.
  signing?: Omit<SignDeps, 'db' | 'workspaceRoot'>;
  // The mailboxes of employees (spec, section 8.24).
  mail?: MailService;
  // The internet of agents (spec, section 8.30): the search, the reader of pages and the translation of a failed
  // model call of the researcher.
  web?: Pick<WebDeps, 'searcher' | 'reader' | 'translateError'>;
  // Mastra workflows of the core, e.g. "background-run" for background tasks.
  workflows?: ConstructorParameters<typeof Mastra>[0] extends infer O ? (O extends { workflows?: infer W } ? W : never) : never;
}

export function createMastraRuntime(deps: MastraRuntimeDeps): Mastra {
  const masking = createMaskingProcessor(deps.db);
  const memory = deps.memory;
  const imageView = deps.sandbox ? [createImageViewProcessor(deps.sandbox.deps.workspaceRoot)] : [];
  const widgetHistory = createWidgetHistoryProcessor();
  const docText = createDocTextProcessor({ service: deps.docText, workspaceRoot: deps.workspaceRoot });
  const agents: Record<string, Agent> = {};
  // The researcher of the internet: masked like every agent, its broken streams asked again (spec, section 8.30).
  const web = deps.web
    ? createWebTools({
        db: deps.db,
        ...deps.web,
        researcher: {
          gateway: deps.gateway,
          inputProcessors: [masking],
          outputProcessors: [masking],
          errorProcessors: [createStreamRetry({ mastraRetries: true })],
          stepMs: deps.stepMs ?? MODEL_CALL_MAX_MS,
          timezone: deps.app.timezone,
        },
      })
    : null;
  // The mail tools do not depend on the person (they read who runs from the request): made once.
  const mailTools = deps.mail ? createMailTools({ db: deps.db, mail: deps.mail, workspaceRoot: deps.workspaceRoot }) : null;
  const mail = deps.mail && mailTools ? { toolsFor: async (userId: string) => ((await deps.mail!.connected(userId)).length > 0 ? mailTools : {}) } : null;
  const mailActions = mailTools ? describeTools(mailTools) : {};
  const signTools = deps.signing ? createSignTools({ db: deps.db, workspaceRoot: deps.workspaceRoot, ...deps.signing }) : null;
  const memoryTools = createMemoryTools(deps.db);
  // An agent no longer in the registry keeps its id as its name in the lists of past conversations.
  const agentName = (id: string) => deps.registry.get(id)?.passport.name ?? id;
  const agentCards = () => deps.registry.agents.map(({ passport }) => ({ id: passport.id, name: passport.name, description: passport.description }));
  const historyTools = createHistoryTools({ db: deps.db, timezone: deps.app.timezone, agentName, workspaceRoot: deps.workspaceRoot, files: deps.files });
  // Questions keep the name of the action: the agent's own tools, else the mailbox's or a connected system's.
  const recorderOf = (rt: (typeof deps.registry.agents)[number]) => {
    const own = agentActions(rt);
    return createApprovalRecorder(deps.db, async (tool) => (tool === SIGN_TOOL ? (await signActionsFor(deps.db))[tool]! : (own[tool] ?? mailActions[tool] ?? deps.connections?.actionsSeen()[tool] ?? null)));
  };
  for (const rt of deps.registry.agents) {
    agents[rt.passport.id] = createMastraAgent(rt, {
      gateway: deps.gateway,
      firstChunkMs: deps.firstChunkMs ?? FALLBACK_FIRST_CHUNK_MS,
      stepMs: deps.stepMs ?? MODEL_CALL_MAX_MS,
      memory,
      memoryTools,
      historyTools,
      ...(deps.connections ? { connections: deps.connections } : {}),
      ...(deps.sandbox ? { sandbox: deps.sandbox } : {}),
      ...(mail ? { mail } : {}),
      ...(signTools ? { signing: signTools } : {}),
      ...(web ? { web } : {}),
      processorsFor: (r, level) => ({
        // The text of documents first: before the layers add the time to the latest message and before masking
        // hides personal data in it (spec, section 8.29).
        input: [
          docText,
          createPromptLayersProcessor({ db: deps.db, timezone: deps.app.timezone, baseRules: r.passport.baseRules !== false, workspaceRoot: deps.workspaceRoot, level, agentId: r.passport.id, agentName, agents: agentCards }),
          // The letterhead, the director and the stamp, after the layers (docs/specs/[20.11.2026]-org-letterhead.md).
          createOrgDocsPromptProcessor({ db: deps.db, filesDir: deps.orgFilesDir, level }),
          // Descriptions of components of earlier turns are not sent again (spec, section 8.31). Before the pictures:
          // they come as a message of their own at the end, and would be taken for the person's latest message.
          ...(level === 'top' ? [widgetHistory] : []),
          // Pictures before masking: a name like «89123456789.png» is found by the real path; the picture itself is
          // never masked (its data is skipped), the text of the request is.
          ...imageView,
          masking,
        ],
        // A sub-agent's request for "Да" reaches the parent's stream too: it is recorded there once,
        // under the run id the chat answers to.
        output: level === 'top' ? [masking, recorderOf(r)] : [masking],
      }),
    });
  }
  return new Mastra({ agents, storage: deps.storage, editor: new MastraEditor(), ...(deps.workflows ? { workflows: deps.workflows } : {}) });
}
