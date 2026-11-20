// Once a day the agent's drafts not changed for a month are removed (spec, section 8.33; owner's decision 20.11:
// «вдруг человек через неделю вернётся… чтобы скрипты сборки документов хотя бы там подольше жили»).
import { logEvent } from '../server/log.ts';
import { DRAFTS_KEEP_DAYS } from '../workspace/layout.ts';
import type { FileStorage } from './engine.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DRAFTS_SWEEP_EVERY_MS = DAY_MS;

export async function sweepDrafts(storage: Pick<FileStorage, 'removeStaleDrafts'>, now = Date.now()): Promise<{ files: number; bytes: number }> {
  const removed = await storage.removeStaleDrafts(now - DRAFTS_KEEP_DAYS * DAY_MS);
  if (removed.files > 0) logEvent('info', 'drafts_removed', removed);
  return removed;
}

export function startDraftsSweep(storage: Pick<FileStorage, 'removeStaleDrafts'>): () => void {
  const sweep = () => void sweepDrafts(storage).catch((error: unknown) => logEvent('error', 'drafts_sweep_failed', { code: 'APP_INTERNAL', error }));
  sweep();
  const timer = setInterval(sweep, DRAFTS_SWEEP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
