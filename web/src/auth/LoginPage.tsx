// /login (spec, section 7): e-mail and password; after an error the e-mail stays in the field.
import { useState, type SubmitEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { signIn } from './api.ts';
import { AuthFrame } from './AuthFrame.tsx';
import styles from './auth.module.css';
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
    <AuthFrame title={ru.login.title} lead={ru.login.lead}>
      <form className={styles.form} onSubmit={(e) => void submit(e)}>
        {error ? <ErrorBanner error={error} /> : null}
        <Field label={ru.login.email}>
          <Input type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={ru.login.password}>
          <Input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" size="lg" block disabled={busy}>
          {busy ? ru.login.submitting : ru.login.submit}
        </Button>
      </form>
    </AuthFrame>
  );
}
