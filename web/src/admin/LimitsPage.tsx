// «Лимиты и расходы» (mockup): the month at a glance — the organisation against its ceiling, the
// average employee against the default limit, calls; spend by day; the limit settings; spend for a
// period. Spend shows with the right «Расходы», the settings with the right «Лимиты».
import type { MeResponse } from '@bba/contracts';
import { useCallback } from 'react';
import { useMe } from '../auth/session.tsx';
import { Card, PageHead, Progress } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dayMonth, rub } from '../ui/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi, type DailySpend } from './api.ts';
import { monthStart, today } from './dates.ts';
import { LimitsSection, type LimitsData } from './LimitsSection.tsx';
import styles from './limits.module.css';
import { hasRight } from './sections.ts';
import section from './section.module.css';
import { UsageChart } from './UsageChart.tsx';
import { UsageSection } from './UsageSection.tsx';

// From here a meter turns amber: most of the month's money is spent.
const WARN_SHARE = 0.8;
const tone = (share: number) => (share >= 1 ? 'bad' : share >= WARN_SHARE ? 'warn' : 'accent');

interface Month {
  totalRub: number;
  orgLimitRub: number | null;
  people: number;
  calls: number;
  days: DailySpend[];
}

interface PageData {
  month: Month | null;
  limits: LimitsData | null;
}

async function loadPage(me: MeResponse): Promise<PageData> {
  const from = monthStart();
  const to = today();
  const [byUser, daily, limits, personal, users] = await Promise.all([
    hasRight(me, 'usage') ? adminApi.usage(from, to, 'user') : null,
    hasRight(me, 'usage') ? adminApi.usageDaily(from, to) : null,
    hasRight(me, 'limits') ? adminApi.limits() : null,
    hasRight(me, 'limits') ? adminApi.personalLimits() : null,
    hasRight(me, 'limits') ? adminApi.users() : null,
  ]);
  return {
    month: byUser && daily ? { totalRub: byUser.totalRub, orgLimitRub: byUser.orgLimitRub, people: byUser.rows.length, calls: byUser.rows.reduce((n, r) => n + r.calls, 0), days: daily.days } : null,
    limits: limits && personal && users ? { limits, personal: personal.users, users: users.users } : null,
  };
}

function Stat({ label, value, sub, share }: { label: string; value: string; sub: string; share: number | null }) {
  return (
    <Card className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statSub}>{sub}</div>
      {share !== null ? (
        <div className={styles.statBar}>
          <Progress value={share} tone={tone(share)} label={`${label}: ${value}`} />
        </div>
      ) : null}
    </Card>
  );
}

function Stats({ month, defaultLimit }: { month: Month; defaultLimit: number | null | undefined }) {
  const average = month.people > 0 ? month.totalRub / month.people : 0;
  return (
    <div className={`${styles.stats} rise`}>
      <Stat label="Организация" value={rub(month.totalRub)} sub={month.orgLimitRub !== null ? `из ${rub(month.orgLimitRub)} в месяц` : 'без общего потолка'} share={month.orgLimitRub ? month.totalRub / month.orgLimitRub : null} />
      <Stat
        label="Средний расход сотрудника"
        value={rub(average)}
        sub={defaultLimit ? `лимит по умолчанию ${rub(defaultLimit)}` : `среди ${month.people} с расходами`}
        share={defaultLimit ? average / defaultLimit : null}
      />
      <Stat label="Запросов к моделям" value={month.calls.toLocaleString('ru-RU')} sub="в этом месяце" share={null} />
    </div>
  );
}

export function LimitsPage() {
  const me = useMe();
  const load = useCallback(() => loadPage(me), [me]);
  // A form starts from what it loads: loaded anew at every opening, never from memory (spec, section 8.22).
  const { state, reload } = useLoad(load);
  const now = new Date();
  const monthTitle = now.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const lead = `${monthTitle[0]!.toUpperCase()}${monthTitle.slice(1).replace(' г.', '')}. Лимиты срабатывают до вызова модели, сброс ${dayMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-01`)}.`;
  const head = <PageHead title="Лимиты и расходы" lead={lead} />;
  if (state.status === 'loading') return <div className={section.stack}>{head}<DelayedBar /></div>;
  if (state.status === 'error') return <div className={section.stack}>{head}<ErrorBanner error={state.error} onRetry={reload} /></div>;
  const { month, limits } = state.data;
  return (
    <div className={section.stack}>
      {head}
      {month ? <Stats month={month} defaultLimit={limits?.limits.defaultUserMonthlyRub} /> : null}
      <div className={styles.columns}>
        {month ? (
          <Card className={`${styles.card} rise`}>
            <div>
              <h2 className={styles.cardTitle}>Расход по дням</h2>
              <div className={styles.cardSub}>рубли, все сотрудники</div>
            </div>
            <UsageChart days={month.days} today={today()} />
          </Card>
        ) : null}
        {limits ? <LimitsSection data={limits} onSaved={reload} /> : null}
      </div>
      {month ? <UsageSection /> : null}
    </div>
  );
}
