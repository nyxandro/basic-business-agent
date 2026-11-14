// «Подключения» (spec, scenario 3): the person's own access to each system — sign-in on the
// system's site (OAuth) or a personal key the server checks; the agent sees what the person sees.
import type { MyConnection } from '@bba/contracts';
import { useState, type SubmitEvent } from 'react';
import { useSearchParams } from 'react-router';
import { ApiRequestError, asApiError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dateTime } from '../ui/format.ts';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { disconnect, fetchConnections, saveStaticConnection, startOAuth } from './api.ts';

const AUTH_FAILED = 'APP_CONNECTOR_AUTH_FAILED';

function statusText(c: MyConnection): string {
  switch (c.status) {
    case 'connected':
      return c.checkedAt ? ru.connections.connected(dateTime(c.checkedAt)) : ru.connections.connectedNoCheck;
    case 'unverified':
      return ru.connections.unverified;
    case 'auth_error':
      return ru.connections.authError;
    default:
      return ru.connections.notConnected;
  }
}

function Connection({ c, onChanged }: { c: MyConnection; onChanged: () => void }) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <li className="connection">
      <div className="connection-head">
        <strong>{c.title}</strong>
        <span className={`status status-${c.status}`}>{statusText(c)}</span>
      </div>
      {error ? <ErrorBanner error={error} /> : null}
      {c.auth === 'identity' ? <p className="muted">{ru.connections.identity}</p> : null}
      {c.auth === 'oauth' ? (
        <button type="button" disabled={busy} onClick={signIn}>
          {c.status === 'not_connected' ? ru.connections.connect : ru.connections.reconnect}
        </button>
      ) : null}
      {c.auth === 'static' ? (
        <form onSubmit={submit}>
          {c.fields.map((f) => (
            <label key={f.name}>
              {f.label}
              <input type={f.secret ? 'password' : 'text'} autoComplete="off" required value={fields[f.name] ?? ''} onChange={(e) => setFields((prev) => ({ ...prev, [f.name]: e.target.value }))} />
            </label>
          ))}
          <button type="submit" disabled={busy}>
            {ru.connections.save}
          </button>
        </form>
      ) : null}
      {c.status !== 'not_connected' && c.auth !== 'identity' ? (
        <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => disconnect(c.id))}>
          {ru.connections.disconnect}
        </button>
      ) : null}
    </li>
  );
}

// The system's sign-in page sends the person back with ?connected=<id> or ?error=<code>&connector=<id>.
function ReturnNotice({ list }: { list: MyConnection[] }) {
  const [params] = useSearchParams();
  const titleOf = (id: string | null) => list.find((c) => c.id === id)?.title ?? id ?? '';
  const connected = params.get('connected');
  const code = params.get('error');
  if (connected) return <p className="banner banner-ok">{ru.connections.connectedNotice(titleOf(connected))}</p>;
  if (!code) return null;
  const title = titleOf(params.get('connector'));
  const message = code === AUTH_FAILED ? ru.connections.authFailed(title) : ru.connections.connectFailed(title);
  return <ErrorBanner error={new ApiRequestError({ code, message, status: 0 })} />;
}

export function ConnectionsPage() {
  const { state, reload } = useLoad(fetchConnections);
  if (state.status === 'loading') return <Skeleton rows={2} />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const list = state.data.connections;
  return (
    <div className="settings-panel">
      <ReturnNotice list={list} />
      {list.length === 0 ? <p className="empty">{ru.connections.empty}</p> : null}
      <ul className="plain-list">
        {list.map((c) => (
          <Connection key={c.id} c={c} onChanged={reload} />
        ))}
      </ul>
    </div>
  );
}
