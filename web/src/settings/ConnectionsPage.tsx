// «Подключения» (spec, scenario 3): the person's own access to each system — sign-in on the
// system's site (OAuth) or a personal key the server checks; the agent sees what the person sees.
import type { MyConnection } from '@bba/contracts';
import { useState, type SubmitEvent } from 'react';
import { useSearchParams } from 'react-router';
import { ApiRequestError, asApiError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { PageFrame } from '../layout/PageFrame.tsx';
import { Button } from '../ui/Button.tsx';
import { Card, EmptyState, IconTile, Pill, type Tone } from '../ui/Display.tsx';
import { ErrorBanner, Notice } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { dateTime } from '../ui/format.ts';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { disconnect, fetchConnections, saveStaticConnection, startOAuth } from './api.ts';
import styles from './settings.module.css';

const AUTH_FAILED = 'APP_CONNECTOR_AUTH_FAILED';

function status(c: MyConnection): { text: string; tone: Tone } {
  switch (c.status) {
    case 'connected':
      return { text: c.checkedAt ? ru.connections.connected(dateTime(c.checkedAt)) : ru.connections.connectedNoCheck, tone: 'ok' };
    case 'unverified':
      return { text: ru.connections.unverified, tone: 'warn' };
    case 'auth_error':
      return { text: ru.connections.authError, tone: 'bad' };
    default:
      return { text: ru.connections.notConnected, tone: 'neutral' };
  }
}

function Connection({ c, onChanged }: { c: MyConnection; onChanged: () => void }) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = status(c);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (raw) {
      // What the person typed stays in the fields (spec, section 7).
      setError(asApiError(raw));
    } finally {
      setBusy(false);
    }
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    void run(() => saveStaticConnection(c.id, fields));
  };
  const signIn = () =>
    void run(async () => {
      const { url } = await startOAuth(c.id);
      window.location.assign(url);
    });
  const canDisconnect = c.status !== 'not_connected' && c.auth !== 'identity';

  return (
    <Card className={`${styles.card} rise`}>
      <div className={styles.connHead}>
        <IconTile icon="plug" size={40} />
        <div className={styles.connText}>
          <div className={styles.connTitle}>{c.title}</div>
          <Pill tone={shown.tone}>{shown.text}</Pill>
        </div>
        {c.auth === 'oauth' ? (
          <Button variant={c.status === 'not_connected' ? 'primary' : 'secondary'} disabled={busy} onClick={signIn}>
            {c.status === 'not_connected' ? ru.connections.connect : ru.connections.reconnect}
          </Button>
        ) : null}
      </div>
      {c.auth === 'identity' ? <p className={styles.caption}>{ru.connections.identity}</p> : null}
      {error ? <ErrorBanner error={error} /> : null}
      {c.auth === 'static' ? (
        <form className={styles.connForm} onSubmit={submit}>
          {c.fields.map((f) => (
            <Field key={f.name} label={f.label}>
              <Input type={f.secret ? 'password' : 'text'} autoComplete="off" required value={fields[f.name] ?? ''} onChange={(e) => setFields((prev) => ({ ...prev, [f.name]: e.target.value }))} />
            </Field>
          ))}
          <div className={styles.actions}>
            {canDisconnect ? (
              <Button variant="ghost" disabled={busy} onClick={() => void run(() => disconnect(c.id))}>
                {ru.connections.disconnect}
              </Button>
            ) : null}
            <Button type="submit" variant="primary" disabled={busy}>
              {ru.connections.save}
            </Button>
          </div>
        </form>
      ) : canDisconnect ? (
        <div className={styles.actions}>
          <Button variant="ghost" disabled={busy} onClick={() => void run(() => disconnect(c.id))}>
            {ru.connections.disconnect}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

// The system's sign-in page sends the person back with ?connected=<id> or ?error=<code>&connector=<id>.
function ReturnNotice({ list }: { list: MyConnection[] }) {
  const [params] = useSearchParams();
  const titleOf = (id: string | null) => list.find((c) => c.id === id)?.title ?? id ?? '';
  const connected = params.get('connected');
  const code = params.get('error');
  if (connected) return <Notice>{ru.connections.connectedNotice(titleOf(connected))}</Notice>;
  if (!code) return null;
  const title = titleOf(params.get('connector'));
  const message = code === AUTH_FAILED ? ru.connections.authFailed(title) : ru.connections.connectFailed(title);
  return <ErrorBanner error={new ApiRequestError({ code, message, status: 0 })} />;
}

export function ConnectionsPage() {
  const { state, reload } = useLoad(fetchConnections, ['me', 'connections']);
  return (
    <PageFrame title={ru.settings.connections} lead={ru.connections.lead}>
      {state.status === 'loading' ? <Skeleton rows={2} /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? (
        <>
          <ReturnNotice list={state.data.connections} />
          {state.data.connections.length === 0 ? (
            <Card>
              <EmptyState title={ru.connections.empty} />
            </Card>
          ) : null}
          {state.data.connections.map((c) => (
            <Connection key={c.id} c={c} onChanged={reload} />
          ))}
        </>
      ) : null}
    </PageFrame>
  );
}
