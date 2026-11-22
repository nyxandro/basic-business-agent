// Rules of multi-step approvals (docs/specs/[20.11.2026]-multi-step-approvals.md, scenario 1): an action of agents and
// the stages of approvers, in order — the rule is on the action as a whole (owner 21.11, F2). The heads of departments
// approve at a stage «руководитель отдела сотрудника» (F1). Only the admin with «Агенты» keeps them.
import type { ApprovalRuleInput, RuleApprover } from '@bba/contracts';
import { writeAudit } from '../audit/audit.ts';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';

export interface RuleRow {
  id: string;
  target: string;
  stages: RuleApprover[][];
  enabled: boolean;
}

export async function listRules(db: Db): Promise<RuleRow[]> {
  const { rows } = await db.query<RuleRow>('SELECT id, target, stages, enabled FROM app.approval_rules ORDER BY target, updated_at');
  return rows;
}

// The enabled rules on an action, oldest first: their stages go one after another.
export async function rulesFor(db: Db, target: string): Promise<RuleRow[]> {
  const { rows } = await db.query<RuleRow>('SELECT id, target, stages, enabled FROM app.approval_rules WHERE enabled AND target = $1 ORDER BY updated_at, id', [target]);
  return rows;
}

async function assertApprovers(db: Db, stages: RuleApprover[][]): Promise<void> {
  const ids = [...new Set(stages.flat().flatMap((a) => (a.kind === 'user' ? [a.userId] : [])))];
  if (ids.length === 0) return;
  const { rows } = await db.query<{ id: string }>('SELECT "id" FROM app."user" WHERE "id" = ANY($1)', [ids]);
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length > 0) throw appError('APP_VALIDATION_FAILED', `approvers ${missing.join(', ')} not found`, { userMessage: 'Укажите хотя бы одного согласующего в каждом этапе: выбранного сотрудника больше нет.' });
}

export async function saveRule(db: Db, actorUserId: string, id: string | null, input: ApprovalRuleInput): Promise<RuleRow> {
  await assertApprovers(db, input.stages);
  const { rows } = id
    ? await db.query<RuleRow>('UPDATE app.approval_rules SET target = $2, stages = $3, enabled = $4, updated_at = now() WHERE id = $1 RETURNING id, target, stages, enabled', [id, input.target, JSON.stringify(input.stages), input.enabled])
    : await db.query<RuleRow>('INSERT INTO app.approval_rules (target, stages, enabled, created_by) VALUES ($1, $2, $3, $4) RETURNING id, target, stages, enabled', [input.target, JSON.stringify(input.stages), input.enabled, actorUserId]);
  const rule = rows[0];
  if (!rule) throw appError('APP_NOT_FOUND', `approval rule ${id} not found`, { userMessage: 'Правило не найдено. Обновите страницу.' });
  await writeAudit(db, { actorUserId, action: id ? 'approval_rule.update' : 'approval_rule.create', target: rule.id, details: { ...input } });
  return rule;
}

export async function deleteRule(db: Db, actorUserId: string, id: string): Promise<void> {
  const { rowCount } = await db.query('DELETE FROM app.approval_rules WHERE id = $1', [id]);
  if (!rowCount) throw appError('APP_NOT_FOUND', `approval rule ${id} not found`, { userMessage: 'Правило не найдено. Обновите страницу.' });
  await writeAudit(db, { actorUserId, action: 'approval_rule.delete', target: id });
}

export async function setDepartmentHeads(db: Db, actorUserId: string, departmentId: string, userIds: string[]): Promise<void> {
  const { rowCount } = await db.query('SELECT 1 FROM app.departments WHERE id = $1', [departmentId]);
  if (!rowCount) throw appError('APP_NOT_FOUND', `department ${departmentId} not found`, { userMessage: 'Отдел не найден. Обновите страницу.' });
  await db.query('DELETE FROM app.department_heads WHERE department_id = $1', [departmentId]);
  if (userIds.length > 0) await db.query('INSERT INTO app.department_heads (department_id, user_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING', [departmentId, userIds]);
  await writeAudit(db, { actorUserId, action: 'department.heads', target: departmentId, details: { userIds } });
}

export async function departmentHeads(db: Db): Promise<Map<string, string[]>> {
  const { rows } = await db.query<{ department_id: string; user_ids: string[] }>('SELECT department_id::text, array_agg(user_id ORDER BY user_id) AS user_ids FROM app.department_heads GROUP BY department_id');
  return new Map(rows.map((r) => [r.department_id, r.user_ids]));
}
