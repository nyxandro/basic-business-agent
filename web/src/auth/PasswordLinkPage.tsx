// /invite/:token and /reset/:token (spec, section 7): the person sets a password and is signed in.
// A used, revoked or expired link shows the server's text instead of the form.
import { MIN_PASSWORD_LENGTH } from '@bba/contracts';
import { useCallback, useState, type SubmitEvent } from 'react';
import { Navigate, useParams } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton, Spinner } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { acceptPasswordLink, readPasswordLink, signIn, type PasswordLinkKind } from './api.ts';
import { useSession } from './session.tsx';

const TEXTS = {
  invite: { title: ru.invite.title, lead: (link: { email: string; name?: string }) => ru.invite.greeting(link.name ?? link.email), submit: ru.invite.submit },
  reset: { title: ru.reset.title, lead: (link: { email: string }) => ru.reset.lead(link.email), submit: ru.reset.submit },
} as const;

export function PasswordLinkPage({ kind }: { kind: PasswordLinkKind }) {
  const { token: param } = useParams();
  if (!param) throw new Error('PasswordLinkPage needs the :token route parameter');
  const token: string = param;
  const texts = TEXTS[kind];
  const { session, refresh } = useSession();
  const load = useCallback(() => readPasswordLink(kind, token), [kind, token]);
  const { state } = useLoad(load);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (done && session.status === 'signed-in') return <Navigate to="/" replace />;

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) return setProblem(ru.password.tooShort(MIN_PASSWORD_LENGTH));
    if (password !== repeat) return setProblem(ru.password.mismatch);
    setProblem(null);
    setBusy(true);
    try {
      const { email } = await acceptPasswordLink(kind, token, password);
      await signIn(email, password);
      const after = await refresh();
      if (after.status === 'error') setError(after.error);
      setDone(true);
    } catch (raw) {
      setError(asApiError(raw));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-form">
        <h1>{texts.title}</h1>
        {state.status === 'loading' ? <Skeleton rows={2} /> : null}
        {state.status === 'error' ? <ErrorBanner error={state.error} /> : null}
        {state.status === 'ready' ? (
          <form onSubmit={(e) => void submit(e)}>
            <p>{texts.lead(state.data)}</p>
            {error ? <ErrorBanner error={error} /> : null}
            <label>
              {ru.password.password}
              <input type="password" name="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label>
              {ru.password.repeat}
              <input type="password" name="repeat" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
            </label>
            {problem ? (
              <p className="field-error" role="alert">
                {problem}
              </p>
            ) : null}
            <button type="submit" disabled={busy}>
              {busy ? (
                <>
                  <Spinner /> {ru.saving}
                </>
              ) : (
                texts.submit
              )}
            </button>
          </form>
        ) : null}
      </div>
    </main>
  );
}
