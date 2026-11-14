import { ru } from '../i18n/ru.ts';
import styles from './feedback.module.css';

export function Spinner() {
  return <span className={styles.spinner} aria-hidden="true" />;
}

// Placeholder rows while a list loads (spec, section 7: «полоски»).
export function Skeleton({ rows }: { rows: number }) {
  return (
    <div className={styles.skeleton} aria-busy="true" aria-label={ru.common.loading}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.skeletonRow} />
      ))}
    </div>
  );
}
