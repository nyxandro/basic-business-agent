// Prompt edits in the admin panel over the agent's instructions.md (spec, scenario 5, section 8.3),
// stored as Mastra Editor versions. Verified at step 0 (V2): an Editor record must exist before the
// first edit, a code agent is served with its file until a version is activated, and clearing the
// active version returns the file. We keep who holds the draft and the file hash in agent_overrides.
import type { PromptState } from '@bba/contracts';
import { createHash } from 'node:crypto';
import type { Mastra } from '@mastra/core';
import type { Agent } from '@mastra/core/agent';
import { writeAudit } from '../audit/audit.ts';
import type { Db } from '../db/pool.ts';
import { inTransaction } from '../db/pool.ts';
import { AppError } from '../errors/app-error.ts';
import { appError } from '../errors/catalog.ts';
import type { AgentRuntime, Registry } from '../loader/registry.ts';

export interface EditorDeps {
  db: Db;
  mastra: Mastra;
  registry: Registry;
}

// The shape is read by the web interface («Агенты»).
export type { PromptState } from '@bba/contracts';

interface OverrideRow {
  draft_version_id: string | null;
  draft_by_name: string | null;
  published_version_id: string | null;
  published_at: Date | null;
  file_instructions_hash: string | null;
  model_id: string | null;
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

// An Editor record must name a model, but the agent's model stays in code (a function resolved per
// run, core/models/resolve.ts) and the Editor never overrides it, so this name is never called.
const EDITOR_RECORD_MODEL = { provider: 'litellm', name: 'resolved-per-run' };

function editor(deps: EditorDeps) {
  const e = deps.mastra.getEditor();
  if (!e) throw new Error('Mastra Editor is not configured on the Mastra instance');
  return e;
}

function runtimeOf(deps: EditorDeps, agentId: string): AgentRuntime {
  const rt = deps.registry.get(agentId);
  if (!rt) throw appError('APP_NOT_FOUND', `agent ${agentId} is not loaded`);
  return rt;
}

async function versionText(deps: EditorDeps, versionId: string | null): Promise<string | null> {
  if (!versionId) return null;
  const store = await deps.mastra.getStorage()!.getStore('agents');
  const version = (await store!.getVersion(versionId)) as { instructions?: unknown } | null;
  return typeof version?.instructions === 'string' ? version.instructions : null;
}

async function overrideRow(db: Db, agentId: string): Promise<OverrideRow | null> {
  const { rows } = await db.query<OverrideRow>(
    `SELECT o.draft_version_id, u."name" AS draft_by_name, o.published_version_id, o.published_at, o.file_instructions_hash, o.model_id
       FROM app.agent_overrides o LEFT JOIN app."user" u ON u."id" = o.draft_by WHERE o.agent_id = $1`,
    [agentId],
  );
  return rows[0] ?? null;
}

export async function getPromptState(deps: EditorDeps, agentId: string): Promise<PromptState> {
  const rt = runtimeOf(deps, agentId);
  const row = await overrideRow(deps.db, agentId);
  return {
    agentId,
    fileInstructions: rt.instructions,
    publishedInstructions: await versionText(deps, row?.published_version_id ?? null),
    draftInstructions: await versionText(deps, row?.draft_version_id ?? null),
    draftVersionId: row?.draft_version_id ?? null,
    draftBy: row?.draft_by_name ?? null,
    publishedAt: row?.published_at?.toISOString() ?? null,
    fileChangedSincePublish: Boolean(row?.published_version_id && row.file_instructions_hash !== hash(rt.instructions)),
    modelId: row?.model_id ?? null,
    allowedModels: await choosableModels(deps.db),
    primaryModel: await primaryModelLabel(deps.db),
  };
}

// The first edit creates the Editor record with the file text and leaves nothing active,
// so the agent keeps being served from its file until someone publishes.
async function ensureEditorRecord(deps: EditorDeps, rt: AgentRuntime): Promise<void> {
  const e = editor(deps);
  const store = await deps.mastra.getStorage()!.getStore('agents');
  if (await store!.getById(rt.passport.id)) return;
  await e.agent.create({ id: rt.passport.id, name: rt.passport.name, instructions: rt.instructions, model: EDITOR_RECORD_MODEL });
  await e.agent.update({ id: rt.passport.id, activeVersionId: null } as never);
}

async function latestVersionId(deps: EditorDeps, agentId: string): Promise<string> {
  const store = await deps.mastra.getStorage()!.getStore('agents');
  const res = (await store!.listVersions({ agentId })) as { versions?: { id: string; versionNumber: number }[] } | { id: string; versionNumber: number }[];
  const versions = Array.isArray(res) ? res : (res.versions ?? []);
  const latest = [...versions].sort((a, b) => b.versionNumber - a.versionNumber)[0];
  if (!latest) throw new Error(`Editor returned no versions for agent ${agentId}`);
  return latest.id;
}

function emptyPrompt(agentId: string): AppError {
  return new AppError({
    code: 'APP_AGENT_INSTRUCTIONS_EMPTY',
    message: `empty instructions for agent ${agentId}`,
    userMessage: 'Нельзя опубликовать пустой промпт — агент перестанет работать.',
    status: 400,
  });
}

export async function saveDraft(deps: EditorDeps, actorUserId: string, agentId: string, input: { text: string; baseDraftVersionId: string | null }): Promise<string> {
  const rt = runtimeOf(deps, agentId);
  if (input.text.trim() === '') throw emptyPrompt(agentId);
  await ensureEditorRecord(deps, rt);
  return inTransaction(deps.db, async (c) => {
    await c.query('INSERT INTO app.agent_overrides (agent_id) VALUES ($1) ON CONFLICT (agent_id) DO NOTHING', [agentId]);
    const { rows } = await c.query<{ draft_version_id: string | null; name: string | null }>(
      `SELECT o.draft_version_id, u."name" FROM app.agent_overrides o LEFT JOIN app."user" u ON u."id" = o.draft_by WHERE o.agent_id = $1 FOR UPDATE OF o`,
      [agentId],
    );
    const current = rows[0]?.draft_version_id ?? null;
    if (current !== input.baseDraftVersionId) {
      const who = rows[0]?.name ?? 'другой администратор';
      throw new AppError({
        code: 'APP_AGENT_DRAFT_CONFLICT',
        message: `draft of ${agentId} changed: expected ${input.baseDraftVersionId ?? 'none'}, found ${current ?? 'none'}`,
        userMessage: `Пока вы редактировали, промпт изменил(а) ${who}. Скопируйте свой текст, обновите страницу и внесите правку в свежую версию.`,
        status: 409,
      });
    }
    await editor(deps).agent.update({ id: agentId, instructions: input.text });
    const versionId = await latestVersionId(deps, agentId);
    await c.query('UPDATE app.agent_overrides SET draft_version_id = $2, draft_by = $3, draft_at = now() WHERE agent_id = $1', [agentId, versionId, actorUserId]);
    await writeAudit(c, { actorUserId, action: 'agent.prompt.draft', target: agentId, details: { versionId } });
    return versionId;
  });
}

export async function publishDraft(deps: EditorDeps, actorUserId: string, agentId: string): Promise<void> {
  const rt = runtimeOf(deps, agentId);
  const row = await overrideRow(deps.db, agentId);
  const draft = await versionText(deps, row?.draft_version_id ?? null);
  if (!row?.draft_version_id || draft === null) throw appError('APP_VALIDATION_FAILED', `agent ${agentId} has no draft to publish`);
  if (draft.trim() === '') throw emptyPrompt(agentId);
  await editor(deps).agent.update({ id: agentId, status: 'published', activeVersionId: row.draft_version_id });
  await deps.db.query(
    `UPDATE app.agent_overrides SET published_version_id = draft_version_id, published_by = $2, published_at = now(),
            file_instructions_hash = $3, draft_version_id = NULL, draft_by = NULL, draft_at = NULL WHERE agent_id = $1`,
    [agentId, actorUserId, hash(rt.instructions)],
  );
  await writeAudit(deps.db, { actorUserId, action: 'agent.prompt.publish', target: agentId, details: { versionId: row.draft_version_id } });
}

export async function revertToFile(deps: EditorDeps, actorUserId: string, agentId: string): Promise<void> {
  runtimeOf(deps, agentId);
  const store = await deps.mastra.getStorage()!.getStore('agents');
  if (await store!.getById(agentId)) await editor(deps).agent.update({ id: agentId, activeVersionId: null } as never);
  await deps.db.query(
    `UPDATE app.agent_overrides SET published_version_id = NULL, published_by = NULL, published_at = NULL, file_instructions_hash = NULL,
            draft_version_id = NULL, draft_by = NULL, draft_at = NULL WHERE agent_id = $1`,
    [agentId],
  );
  await writeAudit(deps.db, { actorUserId, action: 'agent.prompt.revert', target: agentId });
}

// Models an agent may get as its own: enabled chat models of the catalog, while «Агенты выбирают
// модель из каталога» is on (spec, section 8.1).
async function choosableModels(db: Db): Promise<{ id: string; label: string }[]> {
  const { rows } = await db.query<{ id: string; label: string }>(
    `SELECT m.id, m.label FROM app.models m, app.model_settings s WHERE s.agents_choose_model AND m.kind = 'chat' AND m.enabled ORDER BY m.label, m.id`,
  );
  return rows;
}

// The model an agent without its own answers on (core/models/resolve.ts): a primary that is off answers nothing.
async function primaryModelLabel(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ label: string }>(
    'SELECT m.label FROM app.model_settings s JOIN app.models m ON m.id = s.primary_model_id WHERE m.enabled',
  );
  return rows[0]?.label ?? null;
}

export async function setAgentModel(deps: EditorDeps, actorUserId: string, agentId: string, modelId: string | null): Promise<void> {
  runtimeOf(deps, agentId);
  if (modelId !== null && !(await choosableModels(deps.db)).some((m) => m.id === modelId)) {
    throw appError('APP_VALIDATION_FAILED', `model ${modelId} is not a choosable chat model for agent ${agentId}`, {
      details: { field: 'modelId' },
      userMessage: 'Эту модель нельзя выбрать агенту: включите «Агенты выбирают модель из каталога» и выберите включённую модель чата.',
    });
  }
  await deps.db.query(
    'INSERT INTO app.agent_overrides (agent_id, model_id) VALUES ($1, $2) ON CONFLICT (agent_id) DO UPDATE SET model_id = EXCLUDED.model_id',
    [agentId, modelId],
  );
  await writeAudit(deps.db, { actorUserId, action: 'agent.model', target: agentId, details: { modelId } });
}

// The agent a run uses: employees get the published version, the admin's draft check gets the draft.
export async function resolveAgent(deps: EditorDeps, agentId: string, mode: 'published' | 'draft'): Promise<Agent> {
  runtimeOf(deps, agentId);
  const row = await overrideRow(deps.db, agentId);
  return mode === 'draft' && row?.draft_version_id
    ? ((await deps.mastra.getAgentById(agentId, { versionId: row.draft_version_id })) as Agent)
    : ((await deps.mastra.getAgentById(agentId, { status: 'published' })) as Agent);
}
