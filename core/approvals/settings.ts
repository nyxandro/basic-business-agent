// How long a question «Да» waits before it burns (decision of the owner 21.11, F4; docs/specs/[20.11.2026]-notifications.md):
// a question of a conversation and one of a background run, each its own term. The starting values come from
// config/app.ts at the first start; later the admin sets them in «Режимы работы» → «Подтверждения». A question keeps
// the term it was asked with (expires_at), so a shorter term touches only new questions.
import type { ApprovalSettingsDto } from '@bba/contracts';
import type { AppConfig } from '../config/schemas.ts';
import type { Db } from '../db/pool.ts';
import type { RunKind } from '../runtime/request-keys.ts';

export type ApprovalSettings = ApprovalSettingsDto;

export async function ensureApprovalSettings(db: Db, initial: AppConfig['approvals']): Promise<void> {
  await db.query('INSERT INTO app.approval_settings (id, chat_ttl_hours, background_ttl_hours) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING', [
    initial.initialChatTtlHours,
    initial.initialBackgroundTtlHours,
  ]);
}

export async function getApprovalSettings(db: Db): Promise<ApprovalSettings> {
  const { rows } = await db.query<{ chat_ttl_hours: number; background_ttl_hours: number }>('SELECT chat_ttl_hours, background_ttl_hours FROM app.approval_settings WHERE id = 1');
  const row = rows[0];
  if (!row) throw new Error('APP_CONFIG_INVALID: app.approval_settings is empty: ensureApprovalSettings was not called at start-up');
  return { chatTtlHours: row.chat_ttl_hours, backgroundTtlHours: row.background_ttl_hours };
}

export async function setApprovalSettings(db: Db, next: ApprovalSettings): Promise<void> {
  await db.query('UPDATE app.approval_settings SET chat_ttl_hours = $1, background_ttl_hours = $2, updated_at = now() WHERE id = 1', [next.chatTtlHours, next.backgroundTtlHours]);
}

// A background run (by schedule or a plugin's event) asks with nobody at the screen: its term; a conversation and a
// draft check of a prompt — the term of a conversation.
export function ttlHoursFor(settings: ApprovalSettings, runKind: RunKind): number {
  return runKind === 'background' ? settings.backgroundTtlHours : settings.chatTtlHours;
}
