// What each agent may do — «Что агенту можно» (spec, sections 8.30 and 8.31): the internet, the commands of the
// sandbox and the widgets in the chat. Every agent of the installation has its row, written at the start of the server with the core's
// defaults of that moment; a run reads it once, at its start, and works with it to the end.
import type { AgentAbilities } from '@bba/contracts';
import { writeAudit } from '../audit/audit.ts';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { REQUEST_KEYS } from '../run-context/request-keys.ts';

// A new agent may do everything; the admin switches off what it does not need (decision of the owner 19.11).
export const AGENT_ABILITY_DEFAULTS: AgentAbilities = { web: true, commands: true, widgets: true };

// At the start of the server: a row for every agent that has none. An existing row is never touched.
export async function ensureAgentAbilities(db: Db, agentIds: Iterable<string>): Promise<void> {
  const ids = [...agentIds];
  if (ids.length === 0) return;
  await db.query(
    `INSERT INTO app.agent_abilities (agent_id, web, commands, widgets)
     SELECT unnest($1::text[]), $2, $3, $4
     ON CONFLICT (agent_id) DO NOTHING`,
    [ids, AGENT_ABILITY_DEFAULTS.web, AGENT_ABILITY_DEFAULTS.commands, AGENT_ABILITY_DEFAULTS.widgets],
  );
}

export async function listAbilities(db: Db): Promise<Map<string, AgentAbilities>> {
  const { rows } = await db.query<{ agent_id: string } & AgentAbilities>('SELECT agent_id, web, commands, widgets FROM app.agent_abilities');
  return new Map(rows.map((r) => [r.agent_id, { web: r.web, commands: r.commands, widgets: r.widgets }]));
}

// The row of an agent of the registry exists from the start of the server: without it the run is not started.
export async function readAbilities(db: Db, agentId: string): Promise<AgentAbilities> {
  const { rows } = await db.query<AgentAbilities>('SELECT web, commands, widgets FROM app.agent_abilities WHERE agent_id = $1', [agentId]);
  const row = rows[0];
  if (!row) throw new Error(`APP_CONFIG_INVALID: agent ${agentId} has no row in app.agent_abilities: ensureAgentAbilities runs at the start of the server`);
  return { web: row.web, commands: row.commands, widgets: row.widgets };
}

export async function setAbilities(db: Db, agentId: string, patch: Partial<AgentAbilities>, actorUserId: string): Promise<AgentAbilities> {
  const { rows } = await db.query<AgentAbilities>(
    `UPDATE app.agent_abilities SET web = COALESCE($2, web), commands = COALESCE($3, commands), widgets = COALESCE($4, widgets),
            updated_by = $5, updated_at = now()
      WHERE agent_id = $1 RETURNING web, commands, widgets`,
    [agentId, patch.web ?? null, patch.commands ?? null, patch.widgets ?? null, actorUserId],
  );
  const row = rows[0];
  if (!row) throw appError('APP_NOT_FOUND', `agent ${agentId} has no abilities row`);
  const abilities = { web: row.web, commands: row.commands, widgets: row.widgets };
  await writeAudit(db, { actorUserId, action: 'agent.abilities', target: agentId, details: { ...abilities } });
  return abilities;
}

// The abilities a run was started with. Mastra hands the dynamic config of workspace tools a plain object, our
// own code a RequestContext; both are read here.
type Ctx = { get(key: string): unknown } | Record<string, unknown> | undefined;

function rawOf(ctx: Ctx): unknown {
  if (!ctx) return undefined;
  return typeof (ctx as { get?: unknown }).get === 'function' ? (ctx as { get(key: string): unknown }).get(REQUEST_KEYS.abilities) : (ctx as Record<string, unknown>)[REQUEST_KEYS.abilities];
}

export function abilitiesOf(ctx: Ctx): AgentAbilities {
  const raw = rawOf(ctx);
  if (typeof raw !== 'string') throw new Error('APP_CONFIG_INVALID: the run has no abilities: it was started outside a core entry point');
  const parsed = JSON.parse(raw) as Partial<AgentAbilities>;
  if (typeof parsed.web !== 'boolean' || typeof parsed.commands !== 'boolean' || typeof parsed.widgets !== 'boolean') {
    throw new Error(`APP_CONFIG_INVALID: bad abilities in the request context: ${raw}`);
  }
  return { web: parsed.web, commands: parsed.commands, widgets: parsed.widgets };
}

export const abilitiesValue = (abilities: AgentAbilities): string => JSON.stringify({ web: abilities.web, commands: abilities.commands, widgets: abilities.widgets });
