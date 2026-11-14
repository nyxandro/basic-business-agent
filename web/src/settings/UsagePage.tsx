// «Мои расходы» (spec, F5): spent of the monthly limit and, for subscription models, today's tokens.
import { ru } from '../i18n/ru.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dayMonth, rub, thousands } from '../ui/format.ts';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { fetchMyUsage } from './api.ts';

export function UsagePage() {
  const { state, reload } = useLoad(fetchMyUsage);
  if (state.status === 'loading') return <Skeleton rows={2} />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const { month, daily } = state.data;
  const monthLine =
    month.limitRub !== null
      ? ru.usage.spentOf(rub(month.spentRub), rub(month.limitRub), dayMonth(month.resetsOn))
      : month.spentRub > 0
        ? ru.usage.spent(rub(month.spentRub))
        : ru.usage.empty;
  const share = month.limitRub ? Math.min(1, month.spentRub / month.limitRub) : null;
  return (
    <div className="settings-panel">
      <p>{monthLine}</p>
      {share !== null ? <progress max={1} value={share} aria-label={ru.settings.usage} /> : null}
      {daily ? <p>{ru.usage.daily(thousands(daily.usedTokens), thousands(daily.capTokens))}</p> : null}
    </div>
  );
}
