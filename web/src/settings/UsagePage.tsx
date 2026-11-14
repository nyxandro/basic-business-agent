// «Мои расходы» (spec, F5): spent of the monthly limit and, for subscription models, today's tokens.
// Each is a single figure with a meter under it.
import { ru } from '../i18n/ru.ts';
import { PageFrame } from '../layout/PageFrame.tsx';
import { Card, Progress } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dayMonth, monthName, rub, thousands } from '../ui/format.ts';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { fetchMyUsage } from './api.ts';
import styles from './settings.module.css';

// From here the meter turns amber: most of the month's money is gone.
const WARN_SHARE = 0.8;

const toneOf = (share: number) => (share >= 1 ? 'bad' : share >= WARN_SHARE ? 'warn' : 'accent');

export function UsagePage() {
  const { state, reload } = useLoad(fetchMyUsage);
  return (
    <PageFrame title={ru.settings.usage} lead={ru.usage.lead}>
      {state.status === 'loading' ? <Skeleton rows={2} /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? <Usage data={state.data} /> : null}
    </PageFrame>
  );
}

function Usage({ data }: { data: Awaited<ReturnType<typeof fetchMyUsage>> }) {
  const { month, daily } = data;
  const share = month.limitRub ? month.spentRub / month.limitRub : null;
  const caption =
    month.limitRub !== null
      ? ru.usage.spentOf(rub(month.spentRub), rub(month.limitRub), dayMonth(month.resetsOn))
      : month.spentRub > 0
        ? ru.usage.spent(rub(month.spentRub))
        : ru.usage.empty;
  const dailyShare = daily ? daily.usedTokens / daily.capTokens : null;
  return (
    <>
      <Card className={`${styles.card} rise`}>
        <div className={styles.statLabel}>{ru.usage.month(monthName(new Date()))}</div>
        <div className={styles.statRow}>
          <span className={styles.stat}>{rub(month.spentRub)}</span>
          {month.limitRub !== null ? <span className={styles.statOf}>{ru.usage.of(rub(month.limitRub))}</span> : null}
          {share !== null ? <span className={styles.statShare}>{Math.round(share * 100)} %</span> : null}
        </div>
        {share !== null ? <Progress value={share} tone={toneOf(share)} label={ru.settings.usage} height={8} /> : null}
        <p className={styles.caption}>{caption}</p>
      </Card>
      {daily && dailyShare !== null ? (
        <Card className={`${styles.card} rise`}>
          <div className={styles.statLabel}>{ru.usage.subscription}</div>
          <div className={styles.statRow}>
            <span className={styles.stat}>{thousands(daily.usedTokens)}</span>
            <span className={styles.statOf}>{ru.usage.of(`${thousands(daily.capTokens)} ${ru.usage.tokens}`)}</span>
            <span className={styles.statShare}>{Math.round(dailyShare * 100)} %</span>
          </div>
          <Progress value={dailyShare} tone={toneOf(dailyShare)} label={ru.usage.subscription} height={8} />
          <p className={styles.caption}>{ru.usage.daily(thousands(daily.usedTokens), thousands(daily.capTokens))}</p>
        </Card>
      ) : null}
    </>
  );
}
