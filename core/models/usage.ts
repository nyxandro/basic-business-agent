// Our copy of the usage ledger (spec, section 8.1): LiteLLM sends one record per model call
// to POST /app/api/internal/usage; reports read app.usage_events, not LiteLLM's own tables.
import { z } from 'zod';
import type { Db } from '../db/pool.ts';
import { logEvent } from '../log/log.ts';

export const AGENT_HEADER = 'x-bba-agent-id';
// A service call of the core, not a step of the agent: its value names the call (spec, section 8.16).
export const CALL_HEADER = 'x-bba-call';
export const NAMING_CALL = 'thread-title';

const tokenCount = z.number().int().nonnegative().nullish();

// The gateway's search of the internet reports itself too (spec, section 8.30, step 0 V29): it is not counted while
// the search is free (decision of the owner 19.11).
const SEARCH_CALL_TYPES: ReadonlySet<string> = new Set(['search', 'asearch']);

const logSchema = z.object({
  litellm_call_id: z.string().min(1),
  status: z.string(),
  call_type: z.string().nullish(),
  startTime: z.union([z.number(), z.string()]),
  model_group: z.string().nullish(),
  model_id: z.string().nullish(),
  prompt_tokens: tokenCount,
  completion_tokens: tokenCount,
  response_cost: z.number().nullish(),
  error_str: z.string().nullish(),
  metadata: z
    .object({
      user_api_key_user_id: z.string().nullish(),
      user_api_key_team_id: z.string().nullish(),
      requester_custom_headers: z.record(z.string(), z.unknown()).nullish(),
      usage_object: z
        .object({
          prompt_tokens_details: z.object({ cached_tokens: tokenCount }).nullish(),
          completion_tokens_details: z.object({ reasoning_tokens: tokenCount }).nullish(),
          cache_creation_input_tokens: tokenCount,
        })
        .nullish(),
    })
    .nullish(),
});

// LiteLLM's startTime: seconds since 1970 with a fraction, or an ISO date.
export function toLedgerDate(start: number | string): Date {
  return typeof start === 'number' ? new Date(start * 1000) : new Date(start);
}

// `charged` — the employees whose spend grew: their monthly limit is looked at (core/models/limit-notices.ts).
export async function ingestUsage(db: Db, payload: unknown): Promise<{ inserted: number; charged: string[] }> {
  const records = Array.isArray(payload) ? payload : [payload];
  let inserted = 0;
  const charged = new Set<string>();
  for (const raw of records) {
    const parsed = logSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`APP_USAGE_PAYLOAD_INVALID: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    const r = parsed.data;
    if (r.status !== 'success') continue;
    if (r.call_type && SEARCH_CALL_TYPES.has(r.call_type)) continue;
    const usage = r.metadata?.usage_object;
    const agentHeader = r.metadata?.requester_custom_headers?.[AGENT_HEADER];
    const { rowCount } = await db.query(
      `INSERT INTO app.usage_events (at, user_id, team_id, agent_id, model, deployment, is_subscription, input_tokens, output_tokens,
                                     cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_rub, aborted, litellm_call_id)
       -- A call is on the subscription when its model is connected through ChatGPT accounts.
       VALUES ($1,$2,$3,$4,$5,$6,
               COALESCE((SELECT m.connection = 'chatgpt' FROM app.models m WHERE m.id = $5), false),
               $7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (litellm_call_id) DO NOTHING`,
      [
        toLedgerDate(r.startTime),
        r.metadata?.user_api_key_user_id ?? null,
        r.metadata?.user_api_key_team_id ?? null,
        typeof agentHeader === 'string' ? agentHeader : null,
        r.model_group ?? 'unknown',
        r.model_id ?? null,
        r.prompt_tokens ?? 0,
        r.completion_tokens ?? 0,
        usage?.prompt_tokens_details?.cached_tokens ?? 0,
        usage?.cache_creation_input_tokens ?? 0,
        usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        r.response_cost ?? 0,
        // A successful record carries an error text only when the client cut the stream off.
        Boolean(r.error_str),
        r.litellm_call_id,
      ],
    );
    inserted += rowCount ?? 0;
    const userId = r.metadata?.user_api_key_user_id;
    if (rowCount && userId && (r.response_cost ?? 0) > 0) charged.add(userId);
    // A model on a key always costs something: zero means LiteLLM could not price the call (e.g.
    // recognition priced per token whose provider reports no tokens) and the ledger undercounts.
    if (rowCount && !r.response_cost) {
      const paid = await db.query("SELECT 1 FROM app.models WHERE id = $1 AND connection = 'api_key'", [r.model_group ?? '']);
      if (paid.rowCount) logEvent('warn', 'usage_cost_missing', { model: r.model_group, deployment: r.model_id, litellmCallId: r.litellm_call_id });
    }
  }
  return { inserted, charged: [...charged] };
}

export async function todaySubscriptionTokens(db: Db, userId: string, timezone: string): Promise<number> {
  const { rows } = await db.query<{ n: string | null }>(
    `SELECT sum(input_tokens + output_tokens) AS n FROM app.usage_events
      WHERE user_id = $1 AND is_subscription AND at >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`,
    [userId, timezone],
  );
  return Number(rows[0]?.n ?? 0);
}
