// The responsible people who may have the stamp and the signature put through an agent (decision of the owner 21.11, F1):
// a list of people, empty by default, set only by a superadmin; every change goes to the audit. Whoever is not on it has
// no signing tool at all (core/runtime/agent-factory.ts), and the tool asks the list again after «Да».
import type { OrgSigner } from '@bba/contracts';
import type pg from 'pg';
import { writeAudit } from '../audit/audit.ts';
import { inTransaction, type Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';

type Queryable = Pick<pg.PoolClient, 'query'>;

export async function listSigners(db: Queryable): Promise<OrgSigner[]> {
  const { rows } = await db.query<{ user_id: string; name: string; email: string }>(
    `SELECT s.user_id, u."name" AS name, u.email FROM app.org_signers s JOIN app."user" u ON u."id" = s.user_id ORDER BY u."name", u.email`,
  );
  return rows.map((r) => ({ userId: r.user_id, name: r.name, email: r.email }));
}

export async function isSigner(db: Queryable, userId: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM app.org_signers WHERE user_id = $1', [userId]);
  return rows.length > 0;
}

// The list becomes exactly `userIds`; the audit names who was added and who removed.
export async function setSigners(db: Db, actorUserId: string, userIds: readonly string[]): Promise<void> {
  const wanted = [...new Set(userIds)];
  await inTransaction(db, async (c) => {
    const { rows: known } = await c.query<{ id: string }>('SELECT "id" AS id FROM app."user" WHERE "id" = ANY($1)', [wanted]);
    const missing = wanted.filter((id) => !known.some((k) => k.id === id));
    if (missing.length > 0) throw appError('APP_VALIDATION_FAILED', `no people ${missing.join(', ')}`, { userMessage: 'Кого-то из выбранных сотрудников уже нет. Обновите страницу и выберите снова.' });
    const { rows: before } = await c.query<{ user_id: string }>('SELECT user_id FROM app.org_signers');
    const removed = before.map((r) => r.user_id).filter((id) => !wanted.includes(id));
    const added = wanted.filter((id) => !before.some((r) => r.user_id === id));
    if (removed.length > 0) await c.query('DELETE FROM app.org_signers WHERE user_id = ANY($1)', [removed]);
    // Two superadmins saving at once: the second finds the person already there.
    for (const id of added) await c.query('INSERT INTO app.org_signers (user_id, added_by) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [id, actorUserId]);
    if (added.length > 0 || removed.length > 0) await writeAudit(c, { actorUserId, action: 'org_signers.update', target: null, details: { added, removed } });
  });
}
