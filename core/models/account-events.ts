// Failed attempts of the ChatGPT accounts (spec, section 8.1, V20). LiteLLM reports each failed
// attempt of a deployment — each retry on another account too — to POST /app/api/internal/account-events
// (its generic_api callback with llm_api_failure). Only attempts of the accounts are kept: they give
// the account states in «Нейросеть»; successes are already in app.usage_events.
import { z } from 'zod';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { COOLDOWN_SECONDS } from './litellm-config.ts';
import { toLedgerDate } from './usage.ts';

const RETENTION_DAYS = 30;
// The deployment of an account in LiteLLM: "<model>:<account>" (gateway-sync.ts).
const ACCOUNT_DEPLOYMENT = /^[^:]+:(a-[0-9a-f]{8})$/;
// Statuses after which LiteLLM cools a deployment down (its router: 429, 401, 402, 404, 408 and
// every 5xx); after others (400, 403…) it keeps sending requests to it.
const COOLING_4XX = new Set([401, 402, 404, 408, 429]);
// LiteLLM does not cool a deployment down for a broken connection to it.
const NOT_COOLING_CLASS = 'APIConnectionError';

const failureSchema = z.object({
  litellm_call_id: z.string().min(1),
  status: z.string(),
  startTime: z.union([z.number(), z.string()]),
  model_id: z.string().nullish(),
  error_information: z.object({ error_code: z.string().nullish(), error_class: z.string().nullish() }).nullish(),
});

export interface AccountFailure {
  accountId: string;
  deployment: string;
  status: number | null;
}

function httpStatus(code: string | null | undefined): number | null {
  return code && /^\d{3}$/.test(code) ? Number(code) : null;
}

function cools(status: number | null, errorClass: string | null): boolean {
  if (status === null || errorClass === NOT_COOLING_CLASS) return false;
  return status >= 500 || COOLING_4XX.has(status);
}

// Keeps the new attempts and returns them; an attempt sent twice is kept once.
export async function ingestAccountEvents(db: Db, payload: unknown): Promise<AccountFailure[]> {
  const records = Array.isArray(payload) ? payload : [payload];
  const kept: AccountFailure[] = [];
  for (const raw of records) {
    const parsed = failureSchema.safeParse(raw);
    if (!parsed.success) {
      throw appError('APP_VALIDATION_FAILED', `account event payload invalid: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    }
    const r = parsed.data;
    const accountId = ACCOUNT_DEPLOYMENT.exec(r.model_id ?? '')?.[1];
    if (r.status !== 'failure' || !accountId) continue;
    const at = toLedgerDate(r.startTime);
    const status = httpStatus(r.error_information?.error_code);
    const code = r.error_information?.error_class ?? null;
    const cooldownUntil = cools(status, code) ? new Date(at.getTime() + COOLDOWN_SECONDS * 1000) : null;
    // An account disconnected meanwhile is not there any more: its attempts are not kept.
    const { rowCount } = await db.query(
      `INSERT INTO app.account_events (at, account_id, deployment, status, code, cooldown_until, litellm_call_id)
       SELECT $1, a.id, $3, $4, $5, $6, $7 FROM app.chatgpt_accounts a WHERE a.id = $2
       ON CONFLICT (litellm_call_id, deployment) DO NOTHING`,
      [at, accountId, r.model_id, status, code, cooldownUntil, r.litellm_call_id],
    );
    if (!rowCount) continue;
    await db.query(`DELETE FROM app.account_events WHERE account_id = $1 AND at < now() - make_interval(days => $2)`, [accountId, RETENTION_DAYS]);
    kept.push({ accountId, deployment: r.model_id!, status });
  }
  return kept;
}
