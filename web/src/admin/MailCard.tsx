// «Почта сотрудников» in «Подключения» (spec, section 8.24): how many employees connected their mail, and the
// sign-in on the services' sites (Google, Microsoft, Yandex) — set up once for the organisation with the
// app the admin registers there; the return address to give the service is shown with «Скопировать».
import type { AdminMailResponse, MailOAuthProvider } from '@bba/contracts';
import { useState, type SubmitEvent } from 'react';
import { ru } from '../i18n/ru.ts';
import { Button, cx } from '../ui/Button.tsx';
import { Collapse } from '../ui/Collapse.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, IconTile, Pill } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { CopyLink, Feedback, useAction } from './parts.tsx';
import section from './section.module.css';
import styles from './systems.module.css';

const t = ru.admin.mail;
const SERVICES = ru.connections.mail.services;

function AppRow({ app, onSaved }: { app: AdminMailResponse['apps'][number]; onSaved: (next: AdminMailResponse) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ clientId: app.clientId ?? '', clientSecret: '', tenant: app.tenant ?? 'common' });
  const { busy, error, run } = useAction();
  const confirm = useConfirm();
  const provider: MailOAuthProvider = app.provider;

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void run(async () => {
      onSaved(await adminApi.saveMailApp(provider, { clientId: form.clientId, clientSecret: form.clientSecret, ...(provider === 'microsoft' ? { tenant: form.tenant } : {}) }));
      setOpen(false);
      setForm((f) => ({ ...f, clientSecret: '' }));
    });
  }
  async function turnOff() {
    if (!(await confirm({ title: t.offTitle(SERVICES[provider]), text: t.offText, confirmLabel: t.turnOff, danger: true }))) return;
    await run(async () => onSaved(await adminApi.deleteMailApp(provider)));
  }

  return (
    <li className={styles.appRow}>
      <div className={styles.appHead}>
        <div className={styles.appName}>{SERVICES[provider]}</div>
        <Pill tone={app.configured ? 'ok' : 'neutral'}>{app.configured ? t.on : t.off}</Pill>
        <div className={styles.appActions}>
          {app.configured ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void turnOff()}>
              {t.turnOff}
            </Button>
          ) : null}
          <Button size="sm" disabled={busy} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {app.configured ? t.change : t.setUp}
          </Button>
        </div>
      </div>
      <Collapse open={open}>
        <form className={styles.appForm} onSubmit={submit}>
          <p className={section.sub}>{t.help[provider]}</p>
          <Field label={t.clientId}>
            <Input required spellCheck={false} autoComplete="off" value={form.clientId} onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))} />
          </Field>
          <Field label={t.clientSecret}>
            <Input required type="password" autoComplete="new-password" value={form.clientSecret} onChange={(e) => setForm((f) => ({ ...f, clientSecret: e.target.value }))} />
          </Field>
          {provider === 'microsoft' ? (
            <Field label={t.tenant} hint={t.tenantHint}>
              <Input required spellCheck={false} value={form.tenant} onChange={(e) => setForm((f) => ({ ...f, tenant: e.target.value }))} />
            </Field>
          ) : null}
          <Feedback error={error} />
          <div className={styles.appFormActions}>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              {t.cancel}
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {t.save}
            </Button>
          </div>
        </form>
      </Collapse>
    </li>
  );
}

function MailState({ initial }: { initial: AdminMailResponse }) {
  const [state, setState] = useState(initial);
  return (
    <>
      <div className={styles.countRow}>
        <span className={section.sub}>{t.connected(state.connected)}</span>
        {state.authErrors > 0 ? <Pill tone="bad">{t.authErrors(state.authErrors)}</Pill> : null}
      </div>
      <div className={styles.appsBlock}>
        <div className={styles.name}>{t.appsTitle}</div>
        <p className={section.sub}>{t.appsLead}</p>
        <CopyLink link={state.redirectUri} text={t.redirect} />
        <ul className={styles.apps}>
          {state.apps.map((app) => (
            <AppRow key={app.provider} app={app} onSaved={setState} />
          ))}
        </ul>
      </div>
    </>
  );
}

export function MailCard() {
  // Loaded at every opening: the form of an app never starts from memory (spec, section 8.22).
  const { state, reload } = useLoad(adminApi.mail);
  return (
    <Card className={cx(styles.card, styles.wide, 'rise')}>
      <div className={styles.head}>
        <IconTile icon="mail" size={40} />
        <div className={styles.title}>
          <div className={styles.name}>{t.title}</div>
          <div className={section.sub}>{t.lead}</div>
        </div>
      </div>
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? <MailState initial={state.data} /> : null}
    </Card>
  );
}
