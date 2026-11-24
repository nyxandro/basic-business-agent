// A name changed in place in the side panel (a conversation of «Недавние», a project): Enter or ✓
// saves, Esc gives up; a field left with the name unchanged closes, one with a new name stays open
// so nothing typed is lost.
import { useState, type KeyboardEvent } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import fields from './rename-field.module.css';
import { IconButton } from '../ui/Button.tsx';

// `save` gives back the name the server kept; `onDone` gets it once it is saved, null when the
// person gave up; `fromField` — the field had the keyboard to the end (not left for something else).
export function RenameField({ value, label, saveLabel, maxLength, save, onDone }: { value: string; label: string; saveLabel: string; maxLength?: number; save: (name: string) => Promise<string>; onDone: (name: string | null, fromField: boolean) => void }) {
  const [name, setName] = useState(value);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const unchanged = name.trim() === value;

  async function submit() {
    if (busy || !name.trim()) return;
    if (unchanged) return onDone(null, true);
    setBusy(true);
    setError(null);
    try {
      onDone(await save(name.trim()), true);
    } catch (raw) {
      setError(asApiError(raw));
      setBusy(false);
    }
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void submit();
    if (e.key === 'Escape') onDone(null, true);
  };
  return (
    <>
      <div className={fields.field}>
        {/* The field opens on the person's «Переименовать»: focusing it is what they asked for. */}
        <input className={fields.input} autoFocus value={name} maxLength={maxLength} aria-label={label} onChange={(e) => setName(e.target.value)} onKeyDown={onKey} onBlur={() => unchanged && onDone(null, false)} />
        {/* Pressing ✓ must not take the focus away from the field first. */}
        <IconButton icon="check" variant="primary" size="sm" label={saveLabel} onMouseDown={(e) => e.preventDefault()} onClick={() => void submit()} disabled={!name.trim() || busy} />
      </div>
      {error ? <p className={fields.error}>{error.message}</p> : null}
    </>
  );
}
