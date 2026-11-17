// «Подключить почту» (spec, section 8.24): the address first — the server finds the settings itself (a
// popular service, the company's mail service by the domain, the settings the domain publishes) — then one
// step: «Войти через …» on the service's site, or the password for mail programs with a link to where the
// service makes one. «Настроить вручную» opens the servers for any other mail. The server signs in by IMAP
// and SMTP before it saves anything.
import { IMAP_PORTS, MAIL_SECURITY, SMTP_PORTS, type MailDiscovery, type MailSecurity, type MailServers } from '@bba/contracts';
import { useState, type SubmitEvent } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { Collapse } from '../ui/Collapse.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input, Select } from '../ui/Field.tsx';
import { Modal } from '../ui/Modal.tsx';
import { connectMail, discoverMail, startMailOAuth } from './api.ts';
import styles from './mail.module.css';

const t = ru.connections.mail;
// Where a manual entry starts when nothing was found.
const EMPTY_SERVERS = (domain: string): MailServers => ({ imap: { host: `imap.${domain}`, port: 993, security: 'tls' }, smtp: { host: `smtp.${domain}`, port: 465, security: 'tls' } });

function ServerFields({ label, value, ports, onChange }: { label: string; value: MailServers['imap']; ports: readonly number[]; onChange: (next: MailServers['imap']) => void }) {
  return (
    <fieldset className={styles.server}>
      <legend className={styles.legend}>{label}</legend>
      <div className={styles.serverRow}>
        <Field label={t.host} className={styles.host}>
          <Input required spellCheck={false} value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value.trim() })} />
        </Field>
        <Field label={t.port}>
          <Select value={value.port} onChange={(e) => onChange({ ...value, port: Number(e.target.value) })}>
            {ports.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t.security}>
          <Select value={value.security} onChange={(e) => onChange({ ...value, security: e.target.value as MailSecurity })}>
            {MAIL_SECURITY.map((s) => (
              <option key={s} value={s}>
                {t.securities[s]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </fieldset>
  );
}

function SignIn({ found, onBack, onDone }: { found: MailDiscovery; onBack: () => void; onDone: () => void }) {
  const domain = found.email.split('@').pop() ?? '';
  const [servers, setServers] = useState<MailServers>(found.servers ?? EMPTY_SERVERS(domain));
  const [login, setLogin] = useState(found.email);
  const [password, setPassword] = useState('');
  const [manual, setManual] = useState(found.source === 'none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  // A port not in the lists (found settings with an unusual one) is still offered.
  const imapPorts = IMAP_PORTS.includes(servers.imap.port as never) ? IMAP_PORTS : [...IMAP_PORTS, servers.imap.port];
  const smtpPorts = SMTP_PORTS.includes(servers.smtp.port as never) ? SMTP_PORTS : [...SMTP_PORTS, servers.smtp.port];

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (raw) {
      setError(asApiError(raw));
      setBusy(false);
    }
  }
  const signIn = () =>
    void act(async () => {
      const { url } = await startMailOAuth(found.email, found.oauth!);
      window.location.assign(url);
    });
  function submit(event: SubmitEvent) {
    event.preventDefault();
    void act(async () => {
      await connectMail({ email: found.email, provider: found.provider, login, password, imap: servers.imap, smtp: servers.smtp });
      onDone();
    });
  }

  return (
    <div className={styles.step}>
      <div className={styles.found}>
        <div className={styles.foundTitle}>{found.title}</div>
        <div className={styles.foundEmail}>{found.email}</div>
        <p className={styles.caption}>{t.found[found.source]}</p>
      </div>
      {found.oauth ? (
        <Button variant="primary" block disabled={busy} onClick={signIn}>
          {t.signIn(t.services[found.oauth])}
        </Button>
      ) : null}
      {found.password === null && !found.oauth ? <p className={styles.note}>{t.onlyOAuth(found.title)}</p> : null}
      {found.password !== null ? (
        <form className={styles.step} onSubmit={submit}>
          {found.oauth ? <div className={styles.or}>{t.orPassword}</div> : null}
          <Field label={found.password.url ? t.appPassword : t.password} hint={found.password.help}>
            <Input required type="password" autoComplete="off" autoFocus={!found.oauth} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {found.password.url ? (
            <a className={styles.link} href={found.password.url} target="_blank" rel="noreferrer noopener">
              {t.makePassword} ↗
            </a>
          ) : null}
          <button type="button" className={styles.more} aria-expanded={manual} onClick={() => setManual((m) => !m)}>
            {manual ? t.hideManual : t.manual}
          </button>
          <Collapse open={manual}>
            <div className={styles.step}>
              <Field label={t.login}>
                <Input required spellCheck={false} value={login} onChange={(e) => setLogin(e.target.value)} />
              </Field>
              <ServerFields label={t.imap} value={servers.imap} ports={imapPorts} onChange={(imap) => setServers((s) => ({ ...s, imap }))} />
              <ServerFields label={t.smtp} value={servers.smtp} ports={smtpPorts} onChange={(smtp) => setServers((s) => ({ ...s, smtp }))} />
            </div>
          </Collapse>
          {error ? <ErrorBanner error={error} /> : null}
          <div className={styles.actions}>
            <Button variant="ghost" disabled={busy} onClick={onBack}>
              {t.back}
            </Button>
            <Button type="submit" variant={found.oauth ? 'secondary' : 'primary'} disabled={busy || !password}>
              {busy ? t.checking : t.submit}
            </Button>
          </div>
        </form>
      ) : (
        <>
          {error ? <ErrorBanner error={error} /> : null}
          <div className={styles.actions}>
            <Button variant="ghost" disabled={busy} onClick={onBack}>
              {t.back}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Address({ initial, onFound }: { initial: string; onFound: (found: MailDiscovery) => void }) {
  const [email, setEmail] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onFound(await discoverMail(email.trim()));
    } catch (raw) {
      setError(asApiError(raw));
      setBusy(false);
    }
  }
  return (
    <form className={styles.step} onSubmit={(e) => void submit(e)}>
      <Field label={t.email}>
        <Input required autoFocus type="email" autoComplete="email" inputMode="email" spellCheck={false} placeholder="name@company.ru" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      {error ? <ErrorBanner error={error} /> : null}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={busy || !email.trim()}>
          {busy ? t.finding : t.next}
        </Button>
      </div>
    </form>
  );
}

export function MailConnectDialog({ open, initialEmail, onClose, onConnected }: { open: boolean; initialEmail: string; onClose: () => void; onConnected: (email: string) => void }) {
  const [found, setFound] = useState<MailDiscovery | null>(null);
  const close = () => {
    setFound(null);
    onClose();
  };
  return (
    <Modal open={open} onClose={close} label={t.dialog} narrow>
      <div className={styles.dialog}>
        <h2 className={styles.title}>{t.dialog}</h2>
        {found ? (
          <SignIn
            key={found.email}
            found={found}
            onBack={() => setFound(null)}
            onDone={() => {
              setFound(null);
              onConnected(found.email);
            }}
          />
        ) : (
          <Address initial={initialEmail} onFound={setFound} />
        )}
      </div>
    </Modal>
  );
}
