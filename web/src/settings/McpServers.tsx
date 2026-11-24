// MCP servers in «Настройки → Подключения» (docs/specs/[20.11.2026]-mcp-connections.md, scenario 2; the owner's
// decision F2, 21.11): the servers the admin turned on for the person's agents. Without a sign-in or with the shared
// key — the switch «Использовать»; with a sign-in on the system's site — «Подключить»; with a personal key — the
// fields the admin described. The agent gets the actions only of the servers the person turned on.
import type { MyMcpServer } from '@bba/contracts';
import { useState, type SubmitEvent } from 'react';
import { ApiRequestError, asApiError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { Card, IconTile, Pill, type Tone } from '../ui/Display.tsx';
import { ErrorBanner, Notice } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { dateTime } from '../i18n/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { Switch } from '../ui/Switch.tsx';
import { useLoad } from '../ui/use-load.ts';
import { disconnectMcp, fetchMcpServers, saveMcpKey, signInMcp, setMcpServerUse } from './api.ts';
import styles from './settings.module.css';

const t = ru.mcp.employee;
const MCP_PREFIX = 'mcp:';

function stateOf(server: MyMcpServer): { text: string; tone: Tone } {
  if (server.auth === 'none' || server.auth === 'shared_key') return server.using ? { text: t.on, tone: 'ok' } : { text: t.off, tone: 'neutral' };
  switch (server.status) {
    case 'connected':
      return { text: server.checkedAt ? ru.connections.connected(dateTime(server.checkedAt)) : ru.connections.connectedNoCheck, tone: 'ok' };
    case 'unverified':
      return { text: t.unverified, tone: 'warn' };
    case 'auth_error':
      return { text: ru.connections.authError, tone: 'bad' };
    default:
      return { text: ru.connections.notConnected, tone: 'neutral' };
  }
}

function Server({ server, onChanged }: { server: MyMcpServer; onChanged: () => void }) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = stateOf(server);
  const own = server.auth === 'oauth' || server.auth === 'personal_key';
  const connected = own && server.status !== 'not_connected';

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (raw) {
      // What the person typed stays in the fields.
      setError(asApiError(raw));
    } finally {
      setBusy(false);
    }
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    void run(() => saveMcpKey(server.id, fields));
  };
  const signIn = () =>
    void run(async () => {
      window.location.assign((await signInMcp(server.id)).url);
    });

  return (
    <Card className={`${styles.card} rise`}>
      <div className={styles.connHead}>
        <IconTile icon="plug" size={40} />
        <div className={styles.connText}>
          <div className={styles.connTitle}>{server.title}</div>
          <div className={styles.caption}>{t.neededBy(server.agents)}</div>
          <Pill tone={shown.tone}>{shown.text}</Pill>
        </div>
        {server.auth === 'oauth' ? (
          <Button variant={server.status === 'connected' ? 'secondary' : 'primary'} disabled={busy} onClick={signIn}>
            {server.status === 'not_connected' ? t.connect : t.reconnect}
          </Button>
        ) : null}
        {!own ? <Switch checked={server.using} label={t.useLabel(server.title)} disabled={busy} onChange={(on) => void run(() => setMcpServerUse(server.id, on))} /> : null}
      </div>
      {server.trouble ? <p className={styles.caption}>{t.trouble[server.trouble]}</p> : null}
      {error ? <ErrorBanner error={error} /> : null}
      {server.auth === 'personal_key' ? (
        <form className={styles.connForm} onSubmit={submit}>
          {server.fields.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint || undefined}>
              <Input type={f.secret ? 'password' : 'text'} autoComplete="off" required value={fields[f.key] ?? ''} onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))} />
            </Field>
          ))}
          <div className={styles.actions}>
            {connected ? (
              <Button variant="ghost" disabled={busy} onClick={() => void run(() => disconnectMcp(server.id))}>
                {t.disconnect}
              </Button>
            ) : null}
            <Button type="submit" variant="primary" disabled={busy}>
              {connected ? ru.connections.save : t.connect}
            </Button>
          </div>
        </form>
      ) : connected ? (
        <div className={styles.actions}>
          <Button variant="ghost" disabled={busy} onClick={() => void run(() => disconnectMcp(server.id))}>
            {t.disconnect}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

// Back from the system's site: ?connected=mcp:<id>, or ?error=<code>&connector=mcp:<id>.
function ReturnNotice({ servers, params }: { servers: MyMcpServer[]; params: URLSearchParams }) {
  const titleOf = (connector: string | null) => servers.find((s) => `${MCP_PREFIX}${s.id}` === connector)?.title ?? null;
  const connected = titleOf(params.get('connected'));
  if (connected) return <Notice>{t.connectedNotice(connected)}</Notice>;
  const code = params.get('error');
  const failed = titleOf(params.get('connector'));
  if (!code || !failed) return null;
  const message = code === 'APP_CONNECTOR_AUTH_FAILED' ? ru.connections.authFailed(failed) : ru.connections.connectFailed(failed);
  return <ErrorBanner error={new ApiRequestError({ code, message, status: 0 })} />;
}

export function McpServers({ params }: { params: URLSearchParams }) {
  const { state, reload } = useLoad(fetchMcpServers, ['me', 'mcp-servers']);
  if (state.status === 'loading') return <DelayedBar />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  return (
    <>
      <ReturnNotice servers={state.data.servers} params={params} />
      {state.data.servers.map((server) => (
        <Server key={server.id} server={server} onChanged={reload} />
      ))}
    </>
  );
}
