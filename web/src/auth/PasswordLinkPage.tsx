// /invite/:token and /reset/:token (spec, section 7): the person sets a password and is signed in.
// A used, revoked or expired link shows the server's text instead of the form.
import { MIN_PASSWORD_LENGTH } from '@bba/contracts';
import { useCallback, useState, type SubmitEvent } from 'react';
import { Navigate, useParams } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { acceptPasswordLink, readPasswordLink, signIn, type PasswordLinkKind } from './api.ts';
import { AuthFrame } from './AuthFrame.tsx';
import styles from './auth.module.css';
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
    <AuthFrame title={texts.title} lead={state.status === 'ready' ? texts.lead(state.data) : undefined}>
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? (
        <div className={styles.form}>
          <ErrorBanner error={state.error} />
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <form className={styles.form} onSubmit={(e) => void submit(e)}>
          {error ? <ErrorBanner error={error} /> : null}
          <Field label={ru.password.password} hint={ru.password.hint(MIN_PASSWORD_LENGTH)}>
            <Input type="password" name="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label={ru.password.repeat}>
            <Input type="password" name="repeat" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          </Field>
          {problem ? (
            <p className={styles.problem} role="alert">
              {problem}
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="lg" block disabled={busy}>
            {busy ? ru.saving : texts.submit}
          </Button>
        </form>
      ) : null}
    </AuthFrame>
  );
}
