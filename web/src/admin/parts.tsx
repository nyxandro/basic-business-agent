// Small pieces shared by the admin sections: an action with «Сохранено» or an error, a link to
// copy (invites and password resets), a list of checkboxes.
import { useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';

export const SAVED = 'Сохранено';

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function run(action: () => Promise<unknown>, done: string = SAVED): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      return true;
    } catch (raw) {
      setError(asApiError(raw));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, notice, run };
}

export function Feedback({ error, notice }: { error: ApiRequestError | null; notice: string | null }) {
  if (error) return <ErrorBanner error={error} />;
  return notice ? (
    <p className="banner banner-ok" role="status">
      {notice}
    </p>
  ) : null;
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
    <div className="banner banner-ok copy-link">
      <p>{text}</p>
      <input readOnly value={link} aria-label="Ссылка" onFocus={(e) => e.currentTarget.select()} />
      <button type="button" onClick={() => void copy()}>
        {copied ? 'Скопировано' : 'Скопировать'}
      </button>
    </div>
  );
}

export function Checklist({ legend, items, selected, onChange, disabled }: { legend: string; items: { id: string; label: string }[]; selected: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  const toggle = (id: string, on: boolean) => onChange(on ? [...selected, id] : selected.filter((x) => x !== id));
  return (
    <fieldset className="checklist">
      <legend>{legend}</legend>
      {items.map((item) => (
        <label key={item.id} className="check">
          <input type="checkbox" disabled={disabled} checked={selected.includes(item.id)} onChange={(e) => toggle(item.id, e.target.checked)} />
          {item.label}
        </label>
      ))}
    </fieldset>
  );
}
