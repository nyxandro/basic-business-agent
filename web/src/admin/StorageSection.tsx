// «Хранилище файлов» (spec, section 8.23): where the files of conversations and projects are kept. On the
// server's disk by default; a superadmin connects an S3 bucket in a few clicks — a preset of the service
// fills the address and the region, the form asks for the bucket and the two keys, «Проверить и
// подключить» writes, reads and removes a test file there first. While the files move (into the bucket
// or back) the section shows how many folders are left and refreshes itself.
import { STORAGE_PRESETS, type StorageConnectInput, type StorageProvider, type StorageStatus } from '@bba/contracts';
import { useEffect, useState, type SubmitEvent } from 'react';
import { useMe } from '../auth/session.tsx';
import { ru } from '../i18n/ru.ts';
import { Button, cx } from '../ui/Button.tsx';
import { Collapse } from '../ui/Collapse.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, PageHead, Pill } from '../ui/Display.tsx';
import { ErrorBanner, Notice } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { dateTime, fileSize } from '../i18n/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { Switch } from '../ui/Switch.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { Feedback, useAction } from '../ui/form-parts.tsx';
import section from './section.module.css';
import styles from './storage.module.css';

const t = ru.admin.storage;
// While files move, the section asks how far they got this often.
const MOVING_REFRESH_MS = 3000;

const presetOf = (id: StorageProvider) => STORAGE_PRESETS.find((p) => p.id === id) ?? STORAGE_PRESETS[0]!;

function ConnectForm({ onDone, allowed }: { onDone: (status: StorageStatus) => void; allowed: boolean }) {
  const [provider, setProvider] = useState<StorageProvider>('yandex');
  const preset = presetOf(provider);
  const [form, setForm] = useState({ endpoint: preset.endpoint, region: preset.region, pathStyle: preset.pathStyle, bucket: '', prefix: '', accessKeyId: '', secretAccessKey: '' });
  const [more, setMore] = useState(false);
  const { busy, error, run } = useAction();
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  function choose(id: StorageProvider) {
    const next = presetOf(id);
    setProvider(id);
    set({ endpoint: next.endpoint, region: next.region, pathStyle: next.pathStyle });
    // «Другой» has no address of its own: the fields open at once.
    if (id === 'other') setMore(true);
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const input: StorageConnectInput = { provider, ...form };
    void run(async () => onDone(await adminApi.connectStorage(input)), t.connected);
  }

  return (
    <Card className={cx(styles.card, 'rise')}>
      <form className={styles.form} onSubmit={submit}>
        <div className={styles.cardTitle}>{t.connectTitle}</div>
        <div role="group" aria-label={t.provider} className={styles.chips}>
          {STORAGE_PRESETS.map((p) => (
            <button key={p.id} type="button" aria-pressed={provider === p.id} disabled={busy} className={cx(styles.chip, provider === p.id && styles.chipOn)} onClick={() => choose(p.id)}>
              {p.title}
            </button>
          ))}
        </div>
        <p className={styles.help}>{preset.help}</p>
        <Field label={t.bucket} hint={t.bucketHint}>
          <Input required mono autoComplete="off" spellCheck={false} value={form.bucket} onChange={(e) => set({ bucket: e.target.value.trim() })} />
        </Field>
        <div className={styles.pair}>
          <Field label={t.accessKeyId}>
            <Input required mono autoComplete="off" spellCheck={false} value={form.accessKeyId} onChange={(e) => set({ accessKeyId: e.target.value })} />
          </Field>
          <Field label={t.secretAccessKey}>
            <Input required mono type="password" autoComplete="new-password" value={form.secretAccessKey} onChange={(e) => set({ secretAccessKey: e.target.value })} />
          </Field>
        </div>
        <button type="button" className={styles.more} aria-expanded={more} onClick={() => setMore((m) => !m)}>
          {t.more}
        </button>
        <Collapse open={more}>
          <div className={styles.moreBody}>
            <div className={styles.pair}>
              <Field label={t.endpoint}>
                <Input required mono type="url" placeholder="https://" value={form.endpoint} onChange={(e) => set({ endpoint: e.target.value.trim() })} />
              </Field>
              <Field label={t.region}>
                <Input required mono value={form.region} onChange={(e) => set({ region: e.target.value.trim() })} />
              </Field>
            </div>
            <Field label={t.prefix} hint={t.prefixHint}>
              <Input mono spellCheck={false} value={form.prefix} onChange={(e) => set({ prefix: e.target.value.trim() })} />
            </Field>
            <div className={styles.switchRow}>
              <div>
                <div className={styles.switchTitle}>{t.pathStyle}</div>
                <div className={section.sub}>{t.pathStyleHint}</div>
              </div>
              <Switch checked={form.pathStyle} label={t.pathStyle} onChange={(on) => set({ pathStyle: on })} />
            </div>
          </div>
        </Collapse>
        <Feedback error={error} />
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={busy || !allowed}>
            {busy ? t.checking : t.connect}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function KeysForm({ onDone, onCancel }: { onDone: (status: StorageStatus) => void; onCancel: () => void }) {
  const [keys, setKeys] = useState({ accessKeyId: '', secretAccessKey: '' });
  const { busy, error, run } = useAction();
  function submit(event: SubmitEvent) {
    event.preventDefault();
    void run(async () => onDone(await adminApi.storageKeys(keys)), t.keysSaved);
  }
  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.pair}>
        <Field label={t.accessKeyId}>
          <Input required mono autoComplete="off" spellCheck={false} value={keys.accessKeyId} onChange={(e) => setKeys((k) => ({ ...k, accessKeyId: e.target.value }))} />
        </Field>
        <Field label={t.secretAccessKey}>
          <Input required mono type="password" autoComplete="new-password" value={keys.secretAccessKey} onChange={(e) => setKeys((k) => ({ ...k, secretAccessKey: e.target.value }))} />
        </Field>
      </div>
      <Feedback error={error} />
      <div className={styles.actions}>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t.checking : t.saveKeys}
        </Button>
      </div>
    </form>
  );
}

function Connected({ status, onChange, allowed }: { status: StorageStatus; onChange: (status: StorageStatus) => void; allowed: boolean }) {
  const bucket = status.bucket!;
  const [keys, setKeys] = useState(false);
  const confirm = useConfirm();
  const { busy, error, run } = useAction();
  const size = fileSize(status.stored.bytes);
  const state =
    status.state === 'to_s3' ? { tone: 'warn' as const, text: t.stateToS3(status.local.waiting) } : status.state === 'to_local' ? { tone: 'warn' as const, text: t.stateToLocal(status.local.waiting) } : { tone: 'ok' as const, text: t.stateActive };

  async function disconnect() {
    if (!(await confirm({ title: t.disconnectTitle, text: t.disconnectText(size), confirmLabel: t.disconnectConfirm, danger: true }))) return;
    await run(async () => onChange(await adminApi.disconnectStorage()), t.disconnecting);
  }

  return (
    <Card className={cx(styles.card, 'rise')}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <div className={styles.cardTitle}>{t.connectedTitle(presetOf(bucket.provider).title)}</div>
          <div className={section.sub}>
            {t.where(bucket.bucket, bucket.prefix)} · <span className={styles.mono}>{bucket.endpoint}</span>
          </div>
        </div>
        <Pill tone={state.tone}>{state.text}</Pill>
      </div>
      <div className={styles.facts}>
        <div>{t.stored(status.stored.files, size)}</div>
        <div className={section.sub}>{t.copies(status.local.folders)}</div>
        <div className={section.sub}>{t.since(dateTime(bucket.connectedAt))}</div>
      </div>
      {status.lastError ? (
        <div className={styles.warn} role="status">
          {t.lastError(status.lastError.code, dateTime(status.lastError.at))}
        </div>
      ) : null}
      <Collapse open={keys}>
        <div className={styles.moreBody}>
          <KeysForm
            onCancel={() => setKeys(false)}
            onDone={(next) => {
              setKeys(false);
              onChange(next);
            }}
          />
        </div>
      </Collapse>
      <Feedback error={error} />
      {allowed && status.state !== 'to_local' && !keys ? (
        <div className={styles.actions}>
          <Button variant="ghost" disabled={busy} onClick={() => void disconnect()}>
            {t.disconnect}
          </Button>
          <Button disabled={busy} onClick={() => setKeys(true)}>
            {t.changeKeys}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function Storage({ initial, reload }: { initial: StorageStatus; reload: () => void }) {
  const me = useMe();
  const [status, setStatus] = useState(initial);
  // A fresh load (while files move) replaces what the last action returned.
  const [loaded, setLoaded] = useState(initial);
  if (loaded !== initial) {
    setLoaded(initial);
    setStatus(initial);
  }
  const moving = status.state !== 'active';
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(reload, MOVING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [moving, reload]);
  return (
    <>
      {!me.isSuperadmin ? <Notice>{t.onlySuper}</Notice> : null}
      {status.mode === 'local' ? (
        <>
          <Card className={cx(styles.card, 'rise')}>
            <div className={styles.cardTitle}>{t.localTitle}</div>
            <p className={styles.help}>{t.localSub}</p>
          </Card>
          <ConnectForm allowed={me.isSuperadmin} onDone={setStatus} />
        </>
      ) : (
        <Connected status={status} allowed={me.isSuperadmin} onChange={setStatus} />
      )}
    </>
  );
}

export function StorageSection() {
  // A form starts from what it loads: loaded anew at every opening, never from memory (spec, section 8.22).
  const { state, reload } = useLoad(adminApi.storage);
  return (
    <div className={cx(section.stack, styles.page)}>
      <PageHead title={t.title} lead={t.lead} />
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? <Storage initial={state.data} reload={reload} /> : null}
    </div>
  );
}
