// Which kinds of personal data are hidden from the model: the admin's switches (spec, section 8.11).
import { writeAudit } from '../audit/audit.ts';
import { MASKING_KINDS, type MaskingKind } from '../config/schemas.ts';
import type { Db } from '../db/pool.ts';

const KNOWN = new Set<string>(MASKING_KINDS);

// First start: the starting switches come from config/app.ts; after that the admin panel owns them.
export async function ensureMaskingSettings(db: Db, initialKinds: readonly MaskingKind[]): Promise<void> {
  await db.query('INSERT INTO app.masking_settings (kinds) VALUES ($1) ON CONFLICT (id) DO NOTHING', [JSON.stringify(initialKinds)]);
}

export async function getMaskingKinds(db: Db): Promise<Set<MaskingKind>> {
  const { rows } = await db.query<{ kinds: string[] }>('SELECT kinds FROM app.masking_settings');
  if (!rows[0]) throw new Error('APP_CONFIG_INVALID: app.masking_settings is empty: ensureMaskingSettings was not called at start-up');
  return new Set(rows[0].kinds.filter((k): k is MaskingKind => KNOWN.has(k)));
}

export async function setMaskingKinds(db: Db, actorUserId: string, kinds: readonly MaskingKind[]): Promise<void> {
  await db.query('UPDATE app.masking_settings SET kinds = $1, updated_by = $2, updated_at = now()', [JSON.stringify(kinds), actorUserId]);
  await writeAudit(db, { actorUserId, action: 'masking.update', target: null, details: { kinds } });
}
