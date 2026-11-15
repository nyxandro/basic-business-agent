// Colleagues and departments to open a project to (spec, section 8.20): any signed-in person may look
// them up; only active people, never the person themselves.
import type { ColleagueDto, DepartmentDto } from '@bba/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDepartment, setDepartmentMembers } from '../auth/departments.ts';
import { setUserBlocked } from '../auth/users.ts';
import { createTestApp, type TestApp } from '../server/test-app.ts';

let t: TestApp;
const id: Record<string, string> = {};
let olga: string;

const find = async (q: string) => {
  const res = await t.call('GET', `/app/api/colleagues?q=${encodeURIComponent(q)}`, { cookie: olga });
  expect(res.status).toBe(200);
  return ((await res.json()) as { colleagues: ColleagueDto[] }).colleagues;
};

beforeAll(async () => {
  t = await createTestApp();
  for (const [key, name, email] of [
    ['olga', 'Ольга Смирнова', 'olga@example.com'],
    ['petr', 'Пётр Иванов', 'petr@example.com'],
    ['petra', 'Петра Новак', 'p.novak@example.com'],
    ['blocked', 'Пётр Заблокированный', 'petr.blocked@example.com'],
    ['leaving', 'Пётр Уходящий', 'petr.leaving@example.com'],
    ['odd', 'Анна 100%_верная', 'anna@example.com'],
  ] as const) id[key] = await t.createUser({ email, name });
  olga = await t.signIn('olga@example.com');
  const sales = await createDepartment(t.db, id.olga!, 'Продажи');
  const books = await createDepartment(t.db, id.olga!, 'Бухгалтерия');
  await setDepartmentMembers(t.db, id.olga!, sales, [id.olga!, id.petra!, id.blocked!]);
  await setDepartmentMembers(t.db, id.olga!, books, [id.petr!]);
  await setUserBlocked(t.db, id.olga!, id.blocked!, true);
  // The first step of removing an employee (core/admin/deletion.ts) marks them so.
  await t.db.query('INSERT INTO app.user_profiles (user_id, deletion_started_at) VALUES ($1, now()) ON CONFLICT (user_id) DO UPDATE SET deletion_started_at = now()', [id.leaving]);
});
afterAll(async () => {
  await t.close();
});

describe('colleagues and departments', () => {
  it('finds active colleagues by a part of the name or the e-mail, without regard to case', async () => {
    expect(await find('пётр ив')).toEqual([{ id: id.petr, name: 'Пётр Иванов', email: 'petr@example.com', departments: ['Бухгалтерия'] }]);
    expect((await find('PETR@')).map((c) => c.name)).toEqual(['Пётр Иванов']);
    expect((await find('пет')).map((c) => c.name).sort()).toEqual(['Петра Новак', 'Пётр Иванов'].sort());
    // «ё» and «е» are one letter: people type «Петр» for «Пётр».
    expect((await find('Петр Ив')).map((c) => c.name)).toEqual(['Пётр Иванов']);
    expect((await find('novak')).map((c) => c.departments)).toEqual([['Продажи']]);
  });

  it('never gives the person themselves, blocked or leaving people', async () => {
    expect(await find('ольга')).toEqual([]);
    expect((await find('example.com')).map((c) => c.id).sort()).toEqual([id.petr, id.petra, id.odd].sort());
  });

  it('takes % and _ literally and refuses a query under 2 characters', async () => {
    expect((await find('%_')).map((c) => c.name)).toEqual(['Анна 100%_верная']);
    expect(await find('%%')).toEqual([]);
    const short = await t.call('GET', '/app/api/colleagues?q=п', { cookie: olga });
    expect(short.status).toBe(400);
  });

  it('gives at most 20 colleagues', async () => {
    for (let i = 0; i < 22; i++) await t.createUser({ email: `many${i}@example.com`, name: `Многолюдный ${i}` });
    expect(await find('многолюдный')).toHaveLength(20);
  });

  it('lists departments with their active people', async () => {
    const res = await t.call('GET', '/app/api/departments', { cookie: olga });
    const { departments } = (await res.json()) as { departments: DepartmentDto[] };
    expect(departments.map(({ name, members }) => ({ name, members }))).toEqual([
      { name: 'Бухгалтерия', members: 1 },
      { name: 'Продажи', members: 2 },
    ]);
  });

  it('is closed without signing in', async () => {
    expect((await t.call('GET', '/app/api/colleagues?q=пётр')).status).toBe(401);
    expect((await t.call('GET', '/app/api/departments')).status).toBe(401);
  });
});
