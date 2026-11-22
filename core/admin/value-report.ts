// «Польза от агентов» (docs/specs/[20.11.2026]-feedback-and-value.md, scenario 5; owner 21.11, F2): what the agents did
// in the months asked — the people who wrote to them, conversations, documents, actions, letters, background runs,
// searches of the internet, answers by the knowledge base — and the hours of work it stands for by the norms, beside the
// spend on models. Months are the installation's time zone, as the monthly limit counts them (F3). Counted from the
// facts of work (core/work-facts), never from stored messages; no person is named: departments under 3 people together.
import { WORK_KINDS, type ValueCounts, type ValueReport, type WorkKind } from '@bba/contracts';
import type { Db } from '../db/pool.ts';
import { inTransaction } from '../db/pool.ts';
import { writeAudit } from '../audit/audit.ts';
import { appError } from '../errors/catalog.ts';

export const VALUE_MONTHS_MAX = 12;
// A department smaller than this is shown with the others: its numbers would be one or two people's. The same for a group
// shown (an agent, «Другие отделы»): fewer people than this did anything in it — it is not shown.
export const DEPARTMENT_SHOWN_FROM = 3;
export const PEOPLE_SHOWN_FROM = 3;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

const zero = (): Record<WorkKind, number> => Object.fromEntries(WORK_KINDS.map((k) => [k, 0])) as Record<WorkKind, number>;

// Minutes of work the facts stand for: each kind counted by its norm.
export function minutesOf(facts: Record<WorkKind, number>, norms: Record<WorkKind, number>): number {
  return WORK_KINDS.reduce((sum, kind) => sum + facts[kind] * norms[kind], 0);
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm) + 1;
}

export function assertPeriod(from: string, to: string): void {
  if (!MONTH.test(from) || !MONTH.test(to)) throw appError('APP_VALIDATION_FAILED', `months "${from}"–"${to}" are not YYYY-MM`, { userMessage: 'Выберите месяцы периода.' });
  const months = monthsBetween(from, to);
  if (months < 1) throw appError('APP_VALIDATION_FAILED', `period ${from}–${to} ends before it starts`, { userMessage: 'Конец периода раньше начала.' });
  if (months > VALUE_MONTHS_MAX) throw appError('APP_VALIDATION_FAILED', `period of ${months} months`, { userMessage: `Выберите период не больше ${VALUE_MONTHS_MAX} месяцев.` });
}

interface Row {
  scope: 'total' | 'department' | 'agent';
  key: string | null;
  kind: string;
  n: number;
  people: number;
}

export async function valueReport(db: Db, input: { from: string; to: string; timezone: string; agentName: (id: string) => string }): Promise<ValueReport> {
  assertPeriod(input.from, input.to);
  const start = `${input.from}-01`;
  const end = `${input.to}-01`;
  const [norms, settings, departments] = await Promise.all([
    db.query<{ kind: WorkKind; minutes: number }>('SELECT kind, minutes FROM app.value_norms'),
    db.query<{ facts_since: Date; hour_rub: string | null }>('SELECT facts_since, hour_rub FROM app.value_settings'),
    db.query<{ id: string; name: string; members: number }>('SELECT d.id::text, d.name, (SELECT count(*)::int FROM app.department_members m WHERE m.department_id = d.id) AS members FROM app.departments d ORDER BY d.name'),
  ]);
  const normsOf = zero();
  for (const r of norms.rows) normsOf[r.kind] = r.minutes;
  const shown = departments.rows.filter((d) => d.members >= DEPARTMENT_SHOWN_FROM);
  const range = `at >= ($1::date::timestamp AT TIME ZONE $3) AND at < (($2::date + interval '1 month')::timestamp AT TIME ZONE $3)`;
  // An agent shown alone was used by 3 people or more; the others together, as the small departments.
  const used = await db.query<{ agent_id: string }>(`SELECT agent_id FROM app.work_facts WHERE ${range} AND agent_id IS NOT NULL GROUP BY agent_id HAVING count(DISTINCT user_id) >= ${PEOPLE_SHOWN_FROM}`, [start, end, input.timezone]);
  const [facts, spend] = await Promise.all([
    db.query<Row>(
      `WITH f AS (SELECT * FROM app.work_facts WHERE ${range}),
            dep AS (SELECT f.id, f.kind, f.user_id, CASE WHEN d::text = ANY($4) THEN d::text ELSE 'other' END AS key FROM f CROSS JOIN LATERAL unnest(f.department_ids) AS d),
            ag AS (SELECT f.id, f.kind, f.user_id, CASE WHEN f.agent_id = ANY($5) THEN f.agent_id ELSE 'other' END AS key FROM f WHERE f.agent_id IS NOT NULL)
       SELECT 'total' AS scope, NULL AS key, kind, count(*)::int AS n, count(DISTINCT user_id)::int AS people FROM f GROUP BY kind
       UNION ALL
       SELECT 'department', key, kind, count(DISTINCT id)::int, count(DISTINCT user_id)::int FROM dep GROUP BY key, kind
       UNION ALL
       SELECT 'department', key, '*', count(DISTINCT id)::int, count(DISTINCT user_id)::int FROM dep GROUP BY key
       UNION ALL
       SELECT 'agent', key, kind, count(*)::int, count(DISTINCT user_id)::int FROM ag GROUP BY key, kind
       UNION ALL
       SELECT 'agent', key, '*', count(*)::int, count(DISTINCT user_id)::int FROM ag GROUP BY key`,
      [start, end, input.timezone, shown.map((d) => d.id), used.rows.map((r) => r.agent_id)],
    ),
    db.query<{ rub: string; subscription: number }>(`SELECT coalesce(sum(cost_rub), 0) AS rub, count(*) FILTER (WHERE is_subscription)::int AS subscription FROM app.usage_events WHERE ${range}`, [start, end, input.timezone]),
  ]);

  const counts = new Map<string, ValueCounts>();
  const countsOf = (scope: string, key: string | null) => {
    const id = `${scope}:${key ?? ''}`;
    let c = counts.get(id);
    if (!c) counts.set(id, (c = { people: 0, conversations: 0, facts: zero(), minutes: 0 }));
    return c;
  };
  // How many people did anything in a group: one under PEOPLE_SHOWN_FROM is not shown — its numbers are one person's.
  const peopleIn = new Map<string, number>();
  for (const r of facts.rows) {
    if (r.kind === '*') {
      peopleIn.set(`${r.scope}:${r.key ?? ''}`, r.people);
      continue;
    }
    const c = countsOf(r.scope, r.key);
    // «Работали с агентами» — those who wrote to an agent themselves.
    if (r.kind === 'message') c.people = r.people;
    else if (r.kind === 'conversation') c.conversations = r.n;
    else if ((WORK_KINDS as readonly string[]).includes(r.kind)) c.facts[r.kind as WorkKind] = r.n;
  }
  for (const c of counts.values()) c.minutes = minutesOf(c.facts, normsOf);
  const empty = (): ValueCounts => ({ people: 0, conversations: 0, facts: zero(), minutes: 0 });
  const agents = [...counts.entries()].filter(([id]) => id.startsWith('agent:') && id !== 'agent:other').map(([id, c]) => ({ id: id.slice('agent:'.length), name: input.agentName(id.slice('agent:'.length)), ...c }));
  const together = (id: string) => (counts.has(id) && (peopleIn.get(id) ?? 0) >= PEOPLE_SHOWN_FROM ? counts.get(id)! : null);
  return {
    from: input.from,
    to: input.to,
    factsSince: settings.rows[0]!.facts_since.toISOString(),
    norms: normsOf,
    hourRub: settings.rows[0]!.hour_rub === null ? null : Number(settings.rows[0]!.hour_rub),
    total: counts.get('total:') ?? empty(),
    departments: shown.filter((d) => counts.has(`department:${d.id}`)).map((d) => ({ id: d.id, name: d.name, ...counts.get(`department:${d.id}`)! })),
    otherDepartments: together('department:other'),
    agents: agents.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name, 'ru')),
    otherAgents: together('agent:other'),
    // Some work is in no row shown: a group of fewer than 3 people.
    hidden: (counts.has('department:other') && !together('department:other')) || (counts.has('agent:other') && !together('agent:other')),
    spendRub: Number(spend.rows[0]!.rub),
    subscriptionCalls: spend.rows[0]!.subscription,
  };
}

const KIND_TITLES: Record<WorkKind, string> = {
  document: 'Документы',
  action: 'Действия в системах',
  email: 'Письма',
  background_run: 'Фоновые запуски',
  web_research: 'Поиск в интернете',
  knowledge_answer: 'Ответы по базе знаний',
};

// A cell as Excel takes it: text starting with = + - @ is a formula there — it gets a quote first; «;», quotes and line
// breaks go inside quotes.
export const csvCell = (value: string | number) => {
  const raw = String(value);
  const text = typeof value === 'string' && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const hours = (minutes: number) => (Math.round((minutes / 60) * 10) / 10).toLocaleString('ru-RU');

// The report as a file for Excel: «;» between cells and a BOM, so Excel opens Cyrillic right; no person is named.
export function valueCsv(report: ValueReport): string {
  const head = ['Раздел', 'Название', 'Работали с агентами', 'Разговоры', ...WORK_KINDS.map((k) => KIND_TITLES[k]), 'Часы (оценка)'];
  const line = (section: string, name: string, c: ValueCounts) => [section, name, c.people, c.conversations, ...WORK_KINDS.map((k) => c.facts[k]), hours(c.minutes)].map(csvCell).join(';');
  const rows = [
    `Польза от агентов;${report.from} — ${report.to}`,
    'Оценка эквивалентной работы по нормам, а не измеренное сэкономленное время.',
    `Нормы, минут;${WORK_KINDS.map((k) => `${KIND_TITLES[k]} — ${report.norms[k]}`).join(', ')}`,
    `Расход на модели, ₽;${report.spendRub.toFixed(2).replace('.', ',')}`,
    `Обращения через подписку ChatGPT;${report.subscriptionCalls}`,
    '',
    head.map(csvCell).join(';'),
    line('Организация', 'Всего', report.total),
    ...report.departments.map((d) => line('Отдел', d.name, d)),
    ...(report.otherDepartments ? [line('Отдел', 'Другие отделы', report.otherDepartments)] : []),
    ...report.agents.map((a) => line('Агент', a.name, a)),
    ...(report.otherAgents ? [line('Агент', 'Другие агенты', report.otherAgents)] : []),
    ...(report.hidden ? ['', 'Группы, где работали меньше 3 человек, не показаны отдельно — чтобы не было видно работу отдельных людей.'] : []),
  ];
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

export async function saveNorms(db: Db, actorUserId: string, input: { norms: Record<WorkKind, number>; hourRub: number | null }): Promise<void> {
  await inTransaction(db, async (c) => {
    for (const kind of WORK_KINDS) await c.query('UPDATE app.value_norms SET minutes = $2 WHERE kind = $1', [kind, input.norms[kind]]);
    await c.query('UPDATE app.value_settings SET hour_rub = $1', [input.hourRub]);
    await writeAudit(c, { actorUserId, action: 'value.norms', target: 'value_norms', details: { ...input } });
  });
}
