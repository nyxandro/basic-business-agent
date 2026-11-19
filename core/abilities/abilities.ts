// What each agent may do — «Что агенту можно» (spec, section 8.30): the internet and the commands of the
// sandbox. Every agent of the installation has its row, written at the start of the server with the core's
// defaults of that moment; a run reads it once, at its start, and works with it to the end.
import type { AgentAbilities } from '@bba/contracts';
import { writeAudit } from '../audit/audit.ts';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { REQUEST_KEYS } from '../runtime/request-keys.ts';

// A new agent may do everything; the admin switches off what it does not need (decision of the owner 19.11).
export const AGENT_ABILITY_DEFAULTS: AgentAbilities = { web: true, commands: true };

// At the start of the server: a row for every agent that has none. An existing row is never touched.
export async function ensureAgentAbilities(db: Db, agentIds: Iterable<string>): Promise<void> {
  const ids = [...agentIds];
  if (ids.length === 0) return;
  await db.query(
    `INSERT INTO app.agent_abilities (agent_id, web, commands)
     SELECT unnest($1::text[]), $2, $3
     ON CONFLICT (agent_id) DO NOTHING`,
    [ids, AGENT_ABILITY_DEFAULTS.web, AGENT_ABILITY_DEFAULTS.commands],
  );
}

export async function listAbilities(db: Db): Promise<Map<string, AgentAbilities>> {
  const { rows } = await db.query<{ agent_id: string; web: boolean; commands: boolean }>('SELECT agent_id, web, commands FROM app.agent_abilities');
  return new Map(rows.map((r) => [r.agent_id, { web: r.web, commands: r.commands }]));
}

// The row of an agent of the registry exists from the start of the server: without it the run is not started.
export async function readAbilities(db: Db, agentId: string): Promise<AgentAbilities> {
  const { rows } = await db.query<{ web: boolean; commands: boolean }>('SELECT web, commands FROM app.agent_abilities WHERE agent_id = $1', [agentId]);
  const row = rows[0];
  if (!row) throw new Error(`APP_CONFIG_INVALID: agent ${agentId} has no row in app.agent_abilities: ensureAgentAbilities runs at the start of the server`);
  return { web: row.web, commands: row.commands };
}

export async function setAbilities(db: Db, agentId: string, patch: Partial<AgentAbilities>, actorUserId: string): Promise<AgentAbilities> {
  const { rows } = await db.query<{ web: boolean; commands: boolean }>(
    `UPDATE app.agent_abilities SET web = COALESCE($2, web), commands = COALESCE($3, commands), updated_by = $4, updated_at = now()
      WHERE agent_id = $1 RETURNING web, commands`,
    [agentId, patch.web ?? null, patch.commands ?? null, actorUserId],
  );
  const row = rows[0];
  if (!row) throw appError('APP_NOT_FOUND', `agent ${agentId} has no abilities row`);
  const abilities = { web: row.web, commands: row.commands };
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
  if (typeof parsed.web !== 'boolean' || typeof parsed.commands !== 'boolean') throw new Error(`APP_CONFIG_INVALID: bad abilities in the request context: ${raw}`);
  return { web: parsed.web, commands: parsed.commands };
}

export const abilitiesValue = (abilities: AgentAbilities): string => JSON.stringify({ web: abilities.web, commands: abilities.commands });
