// What the person sees while something loads (spec, section 8.22; decision of the owner 17.11): nothing
// while the wait is short — what comes appears in its place — and a thin running line at the top of the
// page only when it takes longer than a second, so a click on a slow connection does not look ignored.
import { useEffect, useState } from 'react';
import { ru } from '../i18n/ru.ts';
import styles from './feedback.module.css';

export const SLOW_LOAD_MS = 1000;

export function Spinner() {
  return <span className={styles.spinner} aria-hidden="true" />;
}

export function DelayedBar() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), SLOW_LOAD_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return slow ? <div className={styles.loadingBar} role="progressbar" aria-label={ru.common.loading} /> : null;
}
