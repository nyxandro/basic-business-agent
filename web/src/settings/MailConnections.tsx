// «Почта» in «Подключения» (spec, section 8.24): the person's mailboxes — each with its service, the way in
// and its state — «Подключить почту», «Отключить», «Подключить заново» when the access broke. Coming back from
// a service's sign-in page the page says how it went.
import type { MailAccountDto } from '@bba/contracts';
import { useState } from 'react';
import { useMe } from '../auth/session.tsx';
import { ApiRequestError, asApiError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, IconTile, Pill } from '../ui/Display.tsx';
import { ErrorBanner, Notice } from '../ui/ErrorBanner.tsx';
import { dateTime } from '../ui/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { useToast } from '../ui/Toast.tsx';
import { useLoad } from '../ui/use-load.ts';
import { disconnectMail, fetchMail } from './api.ts';
import { MailConnectDialog } from './MailConnectDialog.tsx';
import styles from './mail.module.css';
import settings from './settings.module.css';

const t = ru.connections.mail;

function Mailbox({ account, onReconnect, onChanged }: { account: MailAccountDto; onReconnect: (email: string) => void; onChanged: () => void }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const broken = account.status === 'auth_error';

  async function remove() {
    if (!(await confirm({ title: `Отключить ${account.email}?`, text: 'Агент перестанет видеть эту почту. Письма в самой почте останутся.', confirmLabel: t.disconnect, danger: true }))) return;
    setBusy(true);
    setError(null);
    try {
      await disconnectMail(account.id);
      toast(t.disconnected);
      onChanged();
    } catch (raw) {
      setError(asApiError(raw));
      setBusy(false);
    }
  }

  return (
    <li className={styles.box}>
      <IconTile icon="mail" size={36} />
      <div className={styles.boxText}>
        <div className={styles.boxEmail}>{account.email}</div>
        <div className={styles.caption}>
          {account.title} · {account.auth === 'oauth' ? t.viaOAuth : t.viaPassword}
        </div>
      </div>
      <Pill tone={broken ? 'bad' : 'ok'}>{broken ? ru.connections.authError : account.checkedAt ? ru.connections.connected(dateTime(account.checkedAt)) : ru.connections.connectedNoCheck}</Pill>
      <div className={styles.boxActions}>
        {broken ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onReconnect(account.email)}>
            {t.reconnect}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
          {t.disconnect}
        </Button>
      </div>
      {error ? <ErrorBanner error={error} /> : null}
    </li>
  );
}

// The service's sign-in sends the person back with ?mail=<address> or ?mailError=<code>.
function ReturnNotice({ params }: { params: URLSearchParams }) {
  const email = params.get('mail');
  const code = params.get('mailError');
  if (email) return <Notice>{t.connected(email)}</Notice>;
  if (code) return <ErrorBanner error={new ApiRequestError({ code, message: t.returnFailed, status: 0 })} />;
  return null;
}

export function MailConnections({ params }: { params: URLSearchParams }) {
  const me = useMe();
  const { state, reload } = useLoad(fetchMail, ['me', 'mail']);
  const [dialog, setDialog] = useState<{ email: string } | null>(null);
  const toast = useToast();
  const accounts = state.status === 'ready' ? state.data.accounts : [];
  return (
    <Card className={`${settings.card} rise`}>
      <div className={settings.connHead}>
        <IconTile icon="mail" size={40} />
        <div className={settings.connText}>
          <div className={settings.connTitle}>{t.title}</div>
          <p className={settings.caption}>{t.lead}</p>
        </div>
        <Button variant={accounts.length === 0 ? 'primary' : 'secondary'} icon="plus" onClick={() => setDialog({ email: accounts.length === 0 ? me.user.email : '' })}>
          {accounts.length === 0 ? t.connect : t.connectMore}
        </Button>
      </div>
      <ReturnNotice params={params} />
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {accounts.length > 0 ? (
        <ul className={styles.boxes}>
          {accounts.map((a) => (
            <Mailbox key={a.id} account={a} onChanged={reload} onReconnect={(email) => setDialog({ email })} />
          ))}
        </ul>
      ) : null}
      <MailConnectDialog
        open={dialog !== null}
        initialEmail={dialog?.email ?? ''}
        onClose={() => setDialog(null)}
        onConnected={(email) => {
          setDialog(null);
          toast(t.connected(email));
          reload();
        }}
      />
    </Card>
  );
}
