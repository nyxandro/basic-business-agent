// «Расход по дням» (mockup; dataviz): one series — roubles per day of the month, today set apart.
// Bars with rounded tops on the baseline, a gridline with the scale, a tooltip on hover and focus,
// and the same numbers as a table for screen readers.
import { useState } from 'react';
import { cx } from '../ui/Button.tsx';
import { rub } from '../ui/format.ts';
import type { DailySpend } from './api.ts';
import styles from './limits.module.css';

const dayLabel = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

export function UsageChart({ days, today }: { days: DailySpend[]; today: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...days.map((d) => d.costRub), 0);
  const first = days[0];
  const last = days.at(-1);
  if (!first || !last) return null;
  return (
    <figure className={styles.chart}>
      <div className={styles.plot} onMouseLeave={() => setHover(null)}>
        <div className={styles.grid}>
          <span className={styles.gridLabel}>{max > 0 ? rub(max) : ''}</span>
        </div>
        <div className={styles.bars} aria-hidden="true">
          {days.map((d, i) => (
            <div key={d.day} className={styles.slot} onMouseEnter={() => setHover(i)}>
              <div
                className={cx(styles.bar, d.day === today && styles.barNow, hover === i && styles.barHover)}
                style={{ height: max > 0 ? `${Math.max((d.costRub / max) * 100, d.costRub > 0 ? 2 : 0)}%` : 0, animationDelay: `${Math.min(i, 30) * 0.02}s` }}
              />
            </div>
          ))}
        </div>
        {hover !== null && days[hover] ? (
          <div className={styles.tip} style={{ left: `${((hover + 0.5) / days.length) * 100}%` }} role="status">
            <span className={styles.tipDay}>{dayLabel(days[hover].day)}</span>
            <span className={styles.tipValue}>{rub(days[hover].costRub)}</span>
          </div>
        ) : null}
      </div>
      <div className={styles.axis}>
        <span>{dayLabel(first.day)}</span>
        <span>{dayLabel(last.day)}</span>
      </div>
      <table className="visually-hidden">
        <caption>Расход по дням, рубли</caption>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <th scope="row">{dayLabel(d.day)}</th>
              <td>{rub(d.costRub)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
