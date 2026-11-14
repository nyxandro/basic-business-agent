// Small pieces shared by the admin sections: an action that says «Сохранено» in the pop-up notice
// (an error stays next to what failed), a link to copy (invites and password resets), a list of
// checkboxes.
import { useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { Button, cx } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useToast } from '../ui/Toast.tsx';
import styles from './parts.module.css';

export const SAVED = 'Сохранено';

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const toast = useToast();
  // `done` is the pop-up text after success; null — the screen shows the result itself.
  async function run(action: () => Promise<unknown>, done: string | null = SAVED): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (done) toast(done);
      return true;
    } catch (raw) {
      setError(asApiError(raw));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, clearError: () => setError(null) };
}

export function Feedback({ error }: { error: ApiRequestError | null }) {
  return error ? <ErrorBanner error={error} /> : null;
}

export function CopyLink({ link, text }: { link: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(link).then(
      () => setCopied(true),
      // Without clipboard access the link stays selectable in the field.
      (error: unknown) => console.warn('clipboard is not available', error),
    );
  return (
    <div className={cx(styles.copy, 'rise')} role="status">
      <Icon name="check" className={styles.copyIcon} />
      <div className={styles.copyText}>
        <div>{text}</div>
        <input className={styles.copyLink} readOnly value={link} aria-label="Ссылка" onFocus={(e) => e.currentTarget.select()} />
      </div>
      <Button icon="copy" onClick={() => void copy()}>
        {copied ? 'Скопировано' : 'Скопировать'}
      </Button>
    </div>
  );
}

export function Checklist({ legend, items, selected, onChange, disabled }: { legend: string; items: { id: string; label: string }[]; selected: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  const toggle = (id: string, on: boolean) => onChange(on ? [...selected, id] : selected.filter((x) => x !== id));
  return (
    <fieldset className={styles.checklist}>
      <legend className={styles.legend}>{legend}</legend>
      <div className={styles.checks}>
        {items.map((item) => (
          <label key={item.id} className={cx(styles.check, selected.includes(item.id) && styles.checkOn)}>
            <input type="checkbox" disabled={disabled} checked={selected.includes(item.id)} onChange={(e) => toggle(item.id, e.target.checked)} />
            {item.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
