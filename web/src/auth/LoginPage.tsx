// /login (spec, section 7): e-mail and password; after an error the e-mail stays in the field.
import { useState, type SubmitEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Spinner } from '../ui/Loading.tsx';
import { signIn } from './api.ts';
import { safeNextPath } from './next-path.ts';
import { useSession } from './session.tsx';

export function LoginPage() {
  const { session, refresh } = useSession();
  const [params] = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  if (session.status === 'signed-in') return <Navigate to={next} replace />;

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      const after = await refresh();
      if (after.status === 'error') setError(after.error);
    } catch (raw) {
      setError(asApiError(raw));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <form className="auth-form" onSubmit={(e) => void submit(e)}>
        <h1>{ru.login.title}</h1>
        {error ? <ErrorBanner error={error} /> : null}
        <label>
          {ru.login.email}
          <input type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          {ru.login.password}
          <input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? (
            <>
              <Spinner /> {ru.login.submitting}
            </>
          ) : (
            ru.login.submit
          )}
        </button>
      </form>
    </main>
  );
}
