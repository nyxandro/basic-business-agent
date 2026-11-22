// The instant channel to open pages (docs/specs/[20.11.2026]-notifications.md, «Мгновенный канал»; decision of the owner
// 22.11): one connection of the server to Postgres listens for «this person has news» (LISTEN bba_live — the triggers
// of migration 0038 and `signalLive` send it) and passes it to the person's open pages (GET /app/api/me/events). A
// burst of signals for one person becomes one: the page reads the news once. The pages also check every 30 s, so a
// signal lost while the connection was being made again costs at most that.
import pg from 'pg';
import type { Db } from '../db/pool.ts';
import { logEvent } from '../server/log.ts';

export const LIVE_CHANNEL = 'bba_live';
// Signals for one person closer than this become one.
export const LIVE_COALESCE_MS = 150;
const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

// A change the database does not see (an answer of the agent started or ended): the same signal by hand.
export async function signalLive(db: Db, userId: string): Promise<void> {
  try {
    await db.query('SELECT pg_notify($1, $2)', [LIVE_CHANNEL, userId]);
  } catch (error) {
    // The page catches up at its next check; the work that changed something is not undone for a signal.
    logEvent('warn', 'live_signal_failed', { code: 'APP_INTERNAL', userId, error });
  }
}

export interface LiveHub {
  // `tell` is called (at most once per LIVE_COALESCE_MS) when the person has news; returns how to stop.
  subscribe(userId: string, tell: () => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createLiveHub(connectionString: string): LiveHub {
  const listeners = new Map<string, Set<() => void>>();
  const pending = new Map<string, NodeJS.Timeout>();
  let client: pg.Client | null = null;
  let stopped = false;
  let retryMs = RECONNECT_FIRST_MS;
  let retryTimer: NodeJS.Timeout | null = null;

  function deliver(userId: string): void {
    if (!listeners.has(userId) || pending.has(userId)) return;
    pending.set(
      userId,
      setTimeout(() => {
        pending.delete(userId);
        for (const tell of listeners.get(userId) ?? []) tell();
      }, LIVE_COALESCE_MS),
    );
  }

  async function connect(): Promise<void> {
    const next = new pg.Client({ connectionString });
    next.on('notification', (message) => {
      if (message.channel === LIVE_CHANNEL && message.payload) deliver(message.payload);
    });
    // A lost connection (Postgres restarted) is made again, waiting longer each time, up to 30 s.
    next.on('error', (error) => {
      logEvent('error', 'live_listen_failed', { code: 'APP_INTERNAL', error });
      void next.end().catch(() => undefined);
      reconnect();
    });
    await next.connect();
    await next.query(`LISTEN ${LIVE_CHANNEL}`);
    client = next;
    retryMs = RECONNECT_FIRST_MS;
  }

  function reconnect(): void {
    client = null;
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect().catch((error: unknown) => {
        logEvent('error', 'live_listen_failed', { code: 'APP_INTERNAL', error });
        retryMs = Math.min(retryMs * 2, RECONNECT_MAX_MS);
        reconnect();
      });
    }, retryMs);
    retryTimer.unref();
  }

  return {
    subscribe(userId, tell) {
      const own = listeners.get(userId) ?? new Set<() => void>();
      own.add(tell);
      listeners.set(userId, own);
      // Once, and only for this very set: an old connection of the person ending again later (its keep-alive loop wakes
      // up after the abort) must not drop the set a newer connection lives in.
      let gone = false;
      return () => {
        if (gone) return;
        gone = true;
        own.delete(tell);
        if (own.size === 0 && listeners.get(userId) === own) listeners.delete(userId);
      };
    },
    start: () => connect(),
    async stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      await client?.end();
      client = null;
    },
  };
}
