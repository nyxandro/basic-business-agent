// Action journal (spec, section 8.5): one append-only row per executed action that is not
// read-only, plus declines, expiries and background run events. Arguments are summarised without
// secrets and personal data: the journal is read by admins, the data belongs to the employee.
import type pg from 'pg';
import { MASKING_KINDS, type MaskingKind } from '../config/schemas.ts';
import { detect, PLACEHOLDER_NAMES } from '../masking/detect.ts';
import type { RunKind } from '../runtime/request-keys.ts';

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

// `approval_chain_created`, `approval_stage` — multi-step approvals (docs/specs/[20.11.2026]-multi-step-approvals.md).
export type JournalEvent = 'tool_call' | 'tool_declined' | 'approval_expired' | 'background_started' | 'background_finished' | 'background_skipped' | 'approval_chain_created' | 'approval_stage';
export type JournalResult = 'ok' | 'error' | 'declined' | 'expired' | 'skipped' | 'started' | 'sent' | 'approved' | 'unknown';

export interface JournalEntry {
  userId: string | null;
  agentId: string | null;
  runKind: Exclude<RunKind, 'draft'>;
  taskId?: string | null;
  event: JournalEvent;
  tool?: string | null;
  args?: unknown;
  approvedBy?: string | null;
  result: JournalResult;
  errorCode?: string | null;
}

const ALL_KINDS = new Set<MaskingKind>(MASKING_KINDS);
const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authori[sz]ation|cookie|credential/i;
const MAX_STRING = 200;
const MAX_DEPTH = 4;

function scrubText(text: string): string {
  let out = '';
  let cursor = 0;
  for (const d of detect(text, ALL_KINDS)) {
    out += `${text.slice(cursor, d.start)}<${PLACEHOLDER_NAMES[d.kind].toLowerCase()}>`;
    cursor = d.end;
  }
  out += text.slice(cursor);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

export function summariseArgs(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (depth >= MAX_DEPTH) return '…';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => summariseArgs(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '<скрыто>' : summariseArgs(v, depth + 1)]));
  }
  return value;
}

export async function writeJournal(db: Queryable, entry: JournalEntry): Promise<void> {
  await db.query(
    `INSERT INTO app.action_journal (user_id, agent_id, run_kind, task_id, event, tool, args_summary, approved_by, result, error_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      entry.userId,
      entry.agentId,
      entry.runKind,
      entry.taskId ?? null,
      entry.event,
      entry.tool ?? null,
      entry.args === undefined ? null : JSON.stringify(summariseArgs(entry.args)),
      entry.approvedBy ?? null,
      entry.result,
      entry.errorCode ?? null,
    ],
  );
}
