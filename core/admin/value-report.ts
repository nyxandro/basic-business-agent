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
// A department smaller than this is shown with the others: its numbers would be one or two people's.
export const DEPARTMENT_SHOWN_FROM = 3;

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
  const [facts, spend] = await Promise.all([
    db.query<Row>(
      `WITH f AS (SELECT * FROM app.work_facts WHERE ${range}),
            dep AS (SELECT f.id, f.kind, f.user_id, CASE WHEN d::text = ANY($4) THEN d::text ELSE 'other' END AS key FROM f CROSS JOIN LATERAL unnest(f.department_ids) AS d)
       SELECT 'total' AS scope, NULL AS key, kind, count(*)::int AS n, count(DISTINCT user_id)::int AS people FROM f GROUP BY kind
       UNION ALL
       SELECT 'department', key, kind, count(DISTINCT id)::int, count(DISTINCT user_id)::int FROM dep GROUP BY key, kind
       UNION ALL
       SELECT 'agent', agent_id, kind, count(*)::int, count(DISTINCT user_id)::int FROM f WHERE agent_id IS NOT NULL GROUP BY agent_id, kind`,
      [start, end, input.timezone, shown.map((d) => d.id)],
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
  for (const r of facts.rows) {
    const c = countsOf(r.scope, r.key);
    // «Работали с агентами» — those who wrote to an agent themselves.
    if (r.kind === 'message') c.people = r.people;
    else if (r.kind === 'conversation') c.conversations = r.n;
    else if ((WORK_KINDS as readonly string[]).includes(r.kind)) c.facts[r.kind as WorkKind] = r.n;
  }
  for (const c of counts.values()) c.minutes = minutesOf(c.facts, normsOf);
  const empty = (): ValueCounts => ({ people: 0, conversations: 0, facts: zero(), minutes: 0 });
  const agents = [...counts.entries()].filter(([id]) => id.startsWith('agent:')).map(([id, c]) => ({ id: id.slice('agent:'.length), name: input.agentName(id.slice('agent:'.length)), ...c }));
  return {
    from: input.from,
    to: input.to,
    factsSince: settings.rows[0]!.facts_since.toISOString(),
    norms: normsOf,
    hourRub: settings.rows[0]!.hour_rub === null ? null : Number(settings.rows[0]!.hour_rub),
    total: counts.get('total:') ?? empty(),
    departments: shown.filter((d) => counts.has(`department:${d.id}`)).map((d) => ({ id: d.id, name: d.name, ...counts.get(`department:${d.id}`)! })),
    otherDepartments: counts.get('department:other') ?? null,
    agents: agents.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name, 'ru')),
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

const cell = (value: string | number) => {
  const text = String(value);
  return /[;"\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const hours = (minutes: number) => (Math.round((minutes / 60) * 10) / 10).toLocaleString('ru-RU');

// The report as a file for Excel: «;» between cells and a BOM, so Excel opens Cyrillic right; no person is named.
export function valueCsv(report: ValueReport): string {
  const head = ['Раздел', 'Название', 'Работали с агентами', 'Разговоры', ...WORK_KINDS.map((k) => KIND_TITLES[k]), 'Часы (оценка)'];
  const line = (section: string, name: string, c: ValueCounts) => [section, name, c.people, c.conversations, ...WORK_KINDS.map((k) => c.facts[k]), hours(c.minutes)].map(cell).join(';');
  const rows = [
    `Польза от агентов;${report.from} — ${report.to}`,
    'Оценка эквивалентной работы по нормам, а не измеренное сэкономленное время.',
    `Нормы, минут;${WORK_KINDS.map((k) => `${KIND_TITLES[k]} — ${report.norms[k]}`).join(', ')}`,
    `Расход на модели, ₽;${report.spendRub.toFixed(2).replace('.', ',')}`,
    `Обращения через подписку ChatGPT;${report.subscriptionCalls}`,
    '',
    head.map(cell).join(';'),
    line('Организация', 'Всего', report.total),
    ...report.departments.map((d) => line('Отдел', d.name, d)),
    ...(report.otherDepartments ? [line('Отдел', 'Другие отделы', report.otherDepartments)] : []),
    ...report.agents.map((a) => line('Агент', a.name, a)),
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
