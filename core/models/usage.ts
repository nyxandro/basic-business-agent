// Our copy of the usage ledger (spec, section 8.1): LiteLLM sends one record per model call
// to POST /app/api/internal/usage; reports read app.usage_events, not LiteLLM's own tables.
import { z } from 'zod';
import type { ModelConfig } from '../config/schemas.ts';
import type { Db } from '../db/pool.ts';

export const AGENT_HEADER = 'x-bba-agent-id';

const tokenCount = z.number().int().nonnegative().nullish();

const logSchema = z.object({
  litellm_call_id: z.string().min(1),
  status: z.string(),
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

function toDate(start: number | string): Date {
  return typeof start === 'number' ? new Date(start * 1000) : new Date(start);
}

export async function ingestUsage(db: Db, catalog: ModelConfig[], payload: unknown): Promise<number> {
  const records = Array.isArray(payload) ? payload : [payload];
  const subscription = new Set(catalog.filter((m) => m.subscription).map((m) => m.id));
  let inserted = 0;
  for (const raw of records) {
    const parsed = logSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`APP_USAGE_PAYLOAD_INVALID: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    const r = parsed.data;
    if (r.status !== 'success') continue;
    const usage = r.metadata?.usage_object;
    const agentHeader = r.metadata?.requester_custom_headers?.[AGENT_HEADER];
    const { rowCount } = await db.query(
      `INSERT INTO app.usage_events (at, user_id, team_id, agent_id, model, deployment, is_subscription, input_tokens, output_tokens,
                                     cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_rub, aborted, litellm_call_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (litellm_call_id) DO NOTHING`,
      [
        toDate(r.startTime),
        r.metadata?.user_api_key_user_id ?? null,
        r.metadata?.user_api_key_team_id ?? null,
        typeof agentHeader === 'string' ? agentHeader : null,
        r.model_group ?? 'unknown',
        r.model_id ?? null,
        subscription.has(r.model_group ?? ''),
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
  }
  return inserted;
}

export async function todaySubscriptionTokens(db: Db, userId: string, timezone: string): Promise<number> {
  const { rows } = await db.query<{ n: string | null }>(
    `SELECT sum(input_tokens + output_tokens) AS n FROM app.usage_events
      WHERE user_id = $1 AND is_subscription AND at >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`,
    [userId, timezone],
  );
  return Number(rows[0]?.n ?? 0);
}
