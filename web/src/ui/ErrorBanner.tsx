// Error as the person sees it (spec, section 9): what happened, what to do, the code small below.
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { SESSION_EXPIRED, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button, cx } from './Button.tsx';
import styles from './feedback.module.css';

export function ErrorBanner({ error, title, onRetry }: { error: ApiRequestError; title?: string; onRetry?: () => void }) {
  const location = useLocation();
  const next = encodeURIComponent(location.pathname + location.search);
  return (
    <div className={cx(styles.banner, styles.error)} role="alert">
      {title ? <p className={styles.bannerTitle}>{title}</p> : null}
      <p>{error.message}</p>
      {error.nextStep ? <p>{error.nextStep}</p> : null}
      <p className={styles.code}>
        {ru.common.errorCode}: {error.code}
      </p>
      {error.code === SESSION_EXPIRED || onRetry ? (
        <div className={styles.bannerActions}>
          {error.code === SESSION_EXPIRED ? <Link to={`/login?next=${next}`}>{ru.common.signInAgain}</Link> : null}
          {onRetry ? (
            <Button size="sm" onClick={onRetry}>
              {ru.common.retry}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// A positive notice that stays on the page (a returned sign-in, a created link).
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className={cx(styles.banner, styles.notice)} role="status">
      {children}
    </div>
  );
}
