// Colleagues and departments to open a project to (spec, section 8.20). Any signed-in person may look
// them up: names, e-mails (to tell namesakes apart) and departments of active people — never the
// person themselves, nor blocked or leaving people.
import type { ColleagueDto, DepartmentDto } from '@bba/contracts';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/pool.ts';
import { appError } from '../errors/catalog.ts';
import { access, type AppEnv } from '../http/http.ts';

export const COLLEAGUES_MIN_QUERY = 2;
export const COLLEAGUES_MAX = 20;
const ACTIVE = `NOT EXISTS (SELECT 1 FROM app.user_profiles pr WHERE pr.user_id = u."id" AND (pr.blocked_at IS NOT NULL OR pr.deletion_started_at IS NOT NULL))`;

const querySchema = z.object({ q: z.string() });

// `%`, `_` and the escape itself are taken literally. «ё» and «е» are one letter for the search: people
// type «Петр» for «Пётр».
const likeLiteral = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function findColleagues(db: Db, userId: string, q: string): Promise<ColleagueDto[]> {
  const query = q.trim();
  if (query.length < COLLEAGUES_MIN_QUERY) {
    throw appError('APP_VALIDATION_FAILED', `colleague query "${query}" is too short`, { userMessage: `Введите хотя бы ${COLLEAGUES_MIN_QUERY} буквы.` });
  }
  const { rows } = await db.query<{ id: string; name: string; email: string; departments: string[] | null }>(
    `SELECT u."id" AS id, u."name" AS name, u."email" AS email,
            (SELECT array_agg(d.name ORDER BY lower(d.name)) FROM app.department_members m JOIN app.departments d ON d.id = m.department_id WHERE m.user_id = u."id") AS departments
       FROM app."user" u
      WHERE u."id" <> $1 AND ${ACTIVE}
        AND (translate(lower(u."name"), 'ё', 'е') LIKE '%' || $2 || '%' OR lower(u."email") LIKE '%' || $2 || '%')
      ORDER BY lower(u."name"), u."id"
      LIMIT ${COLLEAGUES_MAX}`,
    [userId, likeLiteral(query.toLowerCase().replaceAll('ё', 'е'))],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, departments: r.departments ?? [] }));
}

export async function listDepartmentsForPeople(db: Db): Promise<DepartmentDto[]> {
  const { rows } = await db.query<DepartmentDto>(
    `SELECT d.id, d.name, (SELECT count(*)::int FROM app.department_members m JOIN app."user" u ON u."id" = m.user_id WHERE m.department_id = d.id AND ${ACTIVE}) AS members
       FROM app.departments d ORDER BY lower(d.name), d.id`,
  );
  return rows;
}

export function registerDirectoryRoutes(app: Hono<AppEnv>, db: Db): void {
  app.get('/app/api/colleagues', async (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) throw appError('APP_VALIDATION_FAILED', `bad colleague query: ${parsed.error.message}`);
    return c.json({ colleagues: await findColleagues(db, access(c).userId, parsed.data.q) });
  });
  app.get('/app/api/departments', async (c) => c.json({ departments: await listDepartmentsForPeople(db) }));
}
