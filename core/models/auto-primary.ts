// «Основная модель» never stays empty while a model can answer (owner's decision 25.11): with no
// working primary — none chosen, or the chosen one switched off — an enabled chat model that sees
// images (the rule of the primary, section 8.1) takes its place: the admin's fallback first (it then
// stops being the fallback: the two must differ), else the earliest added. A subscription model can
// answer only through a connected account, so it is a candidate only while one is active.
// Runs in the transaction of each change that may add a candidate or leave the primary empty or off:
// the catalog, «Параметры», a ChatGPT login; and at the start of the server.
import type pg from 'pg';
import { writeAudit } from '../audit/audit.ts';

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

// actorUserId — null at the start of the server.
export async function fillPrimaryModel(db: Queryable, actorUserId: string | null): Promise<void> {
  const { rows } = await db.query<{ id: string; was_fallback: boolean }>(
    `WITH idle AS (
       SELECT s.fallback_model_id FROM app.model_settings s LEFT JOIN app.models p ON p.id = s.primary_model_id
        WHERE p.id IS NULL OR NOT p.enabled
     ), pick AS (
       SELECT m.id, m.id IS NOT DISTINCT FROM i.fallback_model_id AS was_fallback FROM app.models m, idle i
        WHERE m.kind = 'chat' AND m.enabled AND m.vision
          AND (m.connection <> 'chatgpt' OR EXISTS (SELECT 1 FROM app.chatgpt_accounts a WHERE a.status = 'active'))
        ORDER BY m.id IS NOT DISTINCT FROM i.fallback_model_id DESC, m.created_at, m.id LIMIT 1
     )
     UPDATE app.model_settings s
        SET primary_model_id = pick.id,
            fallback_model_id = CASE WHEN pick.was_fallback THEN NULL ELSE s.fallback_model_id END,
            updated_by = $1, updated_at = now()
       FROM pick
     RETURNING pick.id, pick.was_fallback`,
    [actorUserId],
  );
  const picked = rows[0];
  if (picked) await writeAudit(db, { actorUserId, action: 'model.primary.auto', target: picked.id, details: { wasFallback: picked.was_fallback } });
}
