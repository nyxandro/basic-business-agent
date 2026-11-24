// «Лимит за ноябрь 58%» (mockup): the share of the personal monthly limit spent, and when it renews.
// Without a personal limit there is nothing to show.
import type { MyUsage } from '@bba/contracts';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { dayMonth, monthName } from '../i18n/format.ts';
import styles from '../shell/shell.module.css';

const FULL = 100;

export const spentShare = (usage: MyUsage): number | null =>
  usage.month.limitRub ? Math.min(FULL, Math.round((usage.month.spentRub / usage.month.limitRub) * FULL)) : null;

export function LimitMeter({ usage }: { usage: MyUsage | null }) {
  const share = usage ? spentShare(usage) : null;
  if (!usage || share === null) return null;
  return (
    <div className={styles.limit} title={ru.shell.limitResets(dayMonth(usage.month.resetsOn))}>
      <div className={styles.limitRow}>
        <span>{ru.shell.limit(monthName(new Date()))}</span>
        <span className={styles.limitValue}>{share}%</span>
      </div>
      <div className={styles.limitTrack} role="progressbar" aria-label={ru.shell.limit(monthName(new Date()))} aria-valuenow={share} aria-valuemin={0} aria-valuemax={FULL}>
        <div className={cx(styles.limitBar, share >= FULL && styles.limitBarFull)} style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}
