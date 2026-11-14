// Admin tables: a wide table scrolls inside its box, never the page.
import type { ReactNode } from 'react';
import { cx } from './Button.tsx';
import styles from './feedback.module.css';

export function Table({ children, minWidth, label }: { children: ReactNode; minWidth?: number; label?: string }) {
  return (
    <div className={cx(styles.tableBox, 'scroll-thin')}>
      <table className={styles.table} style={minWidth ? { minWidth } : undefined} aria-label={label}>
        {children}
      </table>
    </div>
  );
}

export const numCell = styles.num;
