// Who approves each stage of a request (docs/specs/[20.11.2026]-multi-step-approvals.md, sections 9–10), resolved when
// the request is made and kept with it — a rule changed meanwhile does not move a waiting request:
// - «руководитель отдела сотрудника» — the heads of every department of the employee, any of them;
// - a named person — while active;
// - a stage left with nobody active goes to the admins who keep agents (superadmins, «Агенты»);
// - a person met in an earlier stage is not asked again;
// - the employee who is an approver of a stage: when alone there, the stage is passed and written (owner 21.11, F4);
//   with others, the others decide.
import type { RuleApprover } from '@bba/contracts';
import type { Db } from '../db/pool.ts';

export interface ResolvedStage {
  approvers: string[];
  name: string;
  // The employee was the stage's only approver: passed (F4).
  self: boolean;
  // Its approvers all agreed in an earlier stage already: passed, they are asked once (section 10).
  repeated: boolean;
}

interface Person {
  id: string;
  name: string;
}

async function active(db: Db, ids: string[]): Promise<Person[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<Person>(
    `SELECT u."id", u."name" FROM app."user" u LEFT JOIN app.user_profiles p ON p.user_id = u."id"
      WHERE u."id" = ANY($1) AND p.blocked_at IS NULL AND p.deletion_started_at IS NULL ORDER BY u."name", u."id"`,
    [ids],
  );
  return rows;
}

async function keepers(db: Db): Promise<Person[]> {
  const { rows } = await db.query<Person>(
    `SELECT DISTINCT u."id", u."name" FROM app.user_roles ur JOIN app.roles r ON r.id = ur.role_id JOIN app."user" u ON u."id" = ur.user_id
       LEFT JOIN app.user_profiles p ON p.user_id = u."id"
      WHERE (r.builtin = 'superadmin' OR r.permissions ? 'agents') AND p.blocked_at IS NULL AND p.deletion_started_at IS NULL
      ORDER BY u."name", u."id"`,
  );
  return rows;
}

export async function resolveStages(db: Db, employeeId: string, stages: RuleApprover[][]): Promise<ResolvedStage[]> {
  const { rows: departments } = await db.query<{ name: string; heads: string[] }>(
    `SELECT d.name, coalesce(array_agg(h.user_id) FILTER (WHERE h.user_id IS NOT NULL), '{}') AS heads
       FROM app.department_members m JOIN app.departments d ON d.id = m.department_id LEFT JOIN app.department_heads h ON h.department_id = d.id
      WHERE m.user_id = $1 GROUP BY d.id, d.name ORDER BY d.name`,
    [employeeId],
  );
  const asked = new Set<string>();
  const out: ResolvedStage[] = [];
  for (const stage of stages) {
    const names: string[] = [];
    const ids: string[] = [];
    for (const approver of stage) {
      if (approver.kind === 'user') {
        ids.push(approver.userId);
        continue;
      }
      const heads = departments.flatMap((d) => d.heads);
      ids.push(...heads);
      names.push(departments.length === 0 ? 'руководитель отдела (отдела нет)' : `руководитель отдела ${departments.map((d) => `«${d.name}»`).join(' или ')}`);
    }
    const found = await active(db, [...new Set(ids)]);
    let people = found.filter((p) => !asked.has(p.id));
    for (const p of people) if (!names.some((n) => n === p.name) && stage.some((a) => a.kind === 'user' && a.userId === p.id)) names.push(p.name);
    if (people.length === 0 && found.length > 0) {
      out.push({ approvers: [], name: names.join(', '), self: false, repeated: true });
      continue;
    }
    if (people.length === 0) {
      people = (await keepers(db)).filter((p) => p.id !== employeeId && !asked.has(p.id));
      names.splice(0, names.length, 'администратор (у этапа нет согласующего)');
    }
    // Nobody else at all to ask (the employee is the only keeper): the stage is theirs, as F4.
    const self = people.length === 0 || (people.length === 1 && people[0]!.id === employeeId);
    const approvers = self ? [employeeId] : people.map((p) => p.id).filter((id) => id !== employeeId);
    for (const id of approvers) asked.add(id);
    out.push({ approvers, name: names.join(', '), self, repeated: false });
  }
  return out;
}
