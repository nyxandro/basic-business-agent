// The address of a webhook task (docs/specs/[20.11.2026]-event-tasks.md, scenario 2): another system — Bitrix24,
// amoCRM, a form of a site — sends a message to /app/api/hooks/<secret>, without a session. The answer «принято» (200)
// goes only once the event is written (core/background/events.ts): accepted is never lost. A repeat, a skipped event (a
// flood, a pause) is «принято» too: amoCRM switches an address off after a hundred failures in two hours. No per-minute
// limit: Bitrix24 does not repeat after a 429, the event would be lost. Unknown secret — 404; over 64 KB — 413; neither
// JSON nor a form — 415; the last two are counted at the task.
import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import type { AppEnv } from '../server/http.ts';
import { logEvent } from '../server/log.ts';
import { recordEvent, SUMMARY_MAX } from './events.ts';
import type { TaskRow } from './service.ts';
import { HOOK_PATH, secretHash } from './triggers.ts';

export const HOOK_BODY_MAX = 64 * 1024;
const BODY_KEY_DAYS = 1;

// The body, read up to the limit: a longer one is refused without reading the rest.
async function readLimited(request: Request, max: number): Promise<Buffer | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > max) return null;
  if (!request.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// A form with keys like `data[FIELDS][ID]` (Bitrix24) becomes the object it names.
export function nestForm(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of params) {
    const path = key.split(/\[|\]\[|\]/).filter((part) => part !== '');
    let at = out;
    path.forEach((part, i) => {
      if (i === path.length - 1) at[part] = value;
      else at = (at[part] = typeof at[part] === 'object' && at[part] !== null ? at[part] : {}) as Record<string, unknown>;
    });
  }
  return out;
}

export function parseBody(raw: Buffer, contentType: string): unknown {
  const text = raw.toString('utf8');
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) return nestForm(new URLSearchParams(text));
  return undefined;
}

// The key of the event: Bitrix24 names its event, the object and the time — that is the event for good; any other
// body is its fingerprint for a day (the same request from the same client a day later is a new event).
export function eventKeyOf(body: unknown, raw: Buffer): { key: string; until: Date | null } {
  const b = body as { event?: unknown; ts?: unknown; data?: { FIELDS?: { ID?: unknown } } } | null;
  if (b && typeof b.event === 'string' && (typeof b.ts === 'string' || typeof b.ts === 'number') && (typeof b.data?.FIELDS?.ID === 'string' || typeof b.data?.FIELDS?.ID === 'number')) {
    return { key: `b24:${b.event}:${b.data.FIELDS.ID}:${b.ts}`, until: null };
  }
  return { key: `body:${createHash('sha256').update(raw).digest('hex')}`, until: new Date(Date.now() + BODY_KEY_DAYS * 24 * 60 * 60 * 1000) };
}

async function countReject(db: Db, taskId: string, reason: 'too_large' | 'bad_format'): Promise<void> {
  await db.query(
    `INSERT INTO app.task_event_rejects (task_id, day, reason, count) VALUES ($1, current_date, $2, 1)
     ON CONFLICT (task_id, day, reason) DO UPDATE SET count = app.task_event_rejects.count + 1`,
    [taskId, reason],
  );
  logEvent('warn', 'task_event_rejected', { taskId, reason });
}

export function registerHookRoutes(app: Hono<AppEnv>, deps: { db: Db; wake: () => void }): void {
  app.post(`${HOOK_PATH}:secret`, async (c) => {
    const { rows } = await deps.db.query<TaskRow>(`SELECT * FROM app.background_tasks WHERE trigger = 'webhook' AND webhook_secret_hash = $1`, [secretHash(c.req.param('secret'))]);
    const task = rows[0];
    if (!task) throw appError('APP_NOT_FOUND', 'unknown hook address');
    const raw = await readLimited(c.req.raw, HOOK_BODY_MAX);
    if (!raw) {
      await countReject(deps.db, task.id, 'too_large');
      throw appError('APP_TASK_EVENT_TOO_LARGE', `hook body over ${HOOK_BODY_MAX} bytes`);
    }
    const body = parseBody(raw, c.req.header('content-type') ?? '');
    if (body === undefined) {
      await countReject(deps.db, task.id, 'bad_format');
      throw appError('APP_TASK_EVENT_BAD_FORMAT', `hook body of type "${c.req.header('content-type') ?? ''}"`);
    }
    const { key, until } = eventKeyOf(body, raw);
    const summary = [...JSON.stringify(body)].slice(0, SUMMARY_MAX).join('');
    const recorded = await recordEvent(deps.db, { task, userId: null, key, keyUntil: until, summary, payload: { kind: 'webhook', body } });
    if (recorded.outcome === 'queued') deps.wake();
    return c.json({ ok: true });
  });
}
