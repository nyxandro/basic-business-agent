// Error as the person sees it (spec, section 9): what happened, what to do, the code small below.
import { Link, useLocation } from 'react-router';
import { SESSION_EXPIRED, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';

export function ErrorBanner({ error, title, onRetry }: { error: ApiRequestError; title?: string; onRetry?: () => void }) {
  const location = useLocation();
  const next = encodeURIComponent(location.pathname + location.search);
  return (
    <div className="banner banner-error" role="alert">
      {title ? <p className="banner-title">{title}</p> : null}
      <p>{error.message}</p>
      {error.nextStep ? <p>{error.nextStep}</p> : null}
      <p className="banner-code">
        {ru.common.errorCode}: {error.code}
      </p>
      {error.code === SESSION_EXPIRED ? <Link to={`/login?next=${next}`}>{ru.common.signInAgain}</Link> : null}
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          {ru.common.retry}
        </button>
      ) : null}
    </div>
  );
}
