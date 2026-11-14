// «Моя память» (spec, scenario 6): what the agents remember about the person — read, edit, forget.
import { useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { fetchMemory, forgetMemory, saveMemory } from './api.ts';

export function MemoryPage() {
  const { state, reload } = useLoad(fetchMemory);
  const [draft, setDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setDraft(null);
      setNotice(done);
      reload();
    } catch (raw) {
      setError(asApiError(raw));
    } finally {
      setBusy(false);
    }
  }

  const forget = () => {
    if (window.confirm(ru.memory.forgetConfirm)) void act(forgetMemory, ru.memory.forgotten);
  };

  if (state.status === 'loading') return <Skeleton rows={3} />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const { text, empty } = state.data;
  return (
    <div className="settings-panel">
      <p className="muted">{ru.memory.hint}</p>
      {notice ? <p className="banner banner-ok">{notice}</p> : null}
      {error ? <ErrorBanner error={error} /> : null}
      {draft !== null ? (
        <>
          <textarea aria-label={ru.memory.edit} rows={10} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="row-buttons">
            <button type="button" disabled={busy} onClick={() => void act(() => saveMemory(draft), ru.memory.saved)}>
              {ru.memory.save}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setDraft(null)}>
              {ru.memory.cancel}
            </button>
          </div>
        </>
      ) : (
        <>
          {empty ? <p className="empty">{ru.memory.empty}</p> : <pre className="memory-text">{text}</pre>}
          <div className="row-buttons">
            <button type="button" disabled={busy} onClick={() => setDraft(text)}>
              {ru.memory.edit}
            </button>
            {!empty ? (
              <button type="button" className="secondary" disabled={busy} onClick={forget}>
                {ru.memory.forget}
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
