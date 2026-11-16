// «Корзина проекта» (spec, section 8.20): what one person removed, or one answer of the agent, as a
// group with «Вернуть все»; each file with its place, size, the day it goes for good, «Скачать» and
// «Вернуть». In an archived project — for reading only.
import type { TrashBatchDto } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button, IconButton } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { FileIcon } from '../ui/FileIcon.tsx';
import { dateTime, fileSize, fullDate } from '../ui/format.ts';
import { Skeleton } from '../ui/Loading.tsx';
import { Modal } from '../ui/Modal.tsx';
import { useToast } from '../ui/Toast.tsx';
import { useLoad } from '../ui/use-load.ts';
import { fetchTrash, restoreFromTrash, trashFileUrl } from './api.ts';
import styles from './projects.module.css';

function Trash({ projectId, readOnly, onRestored }: { projectId: string; readOnly: boolean; onRestored: () => void }) {
  const load = useCallback(() => fetchTrash(projectId), [projectId]);
  const { state, reload } = useLoad(load, ['project', projectId, 'trash']);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function restore(what: { ids: string[] } | { batchId: string }) {
    setBusy(true);
    setError(null);
    try {
      await restoreFromTrash(projectId, what);
      toast(ru.projects.restored);
      onRestored();
    } catch (raw) {
      setError(asApiError(raw));
    } finally {
      setBusy(false);
      reload();
    }
  }
  const author = (b: TrashBatchDto) => (b.via === 'page' ? ru.projects.trashBy(b.deletedBy) : b.overlapped ? ru.projects.trashByAgentOverlapped(b.deletedBy) : ru.projects.trashByAgent(b.deletedBy));
  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>{ru.projects.trashTitle}</h2>
      {error ? <ErrorBanner error={error} /> : null}
      {state.status === 'loading' ? <Skeleton rows={2} /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' && state.data.batches.length === 0 ? <p className={styles.empty}>{ru.projects.trashEmpty}</p> : null}
      {state.status === 'ready'
        ? state.data.batches.map((b) => (
            <section key={b.id} className={styles.batch} aria-label={`${author(b)} · ${dateTime(b.deletedAt)}`}>
              <div className={styles.batchHead}>
                <span className={styles.rowMeta}>
                  {author(b)} · {dateTime(b.deletedAt)}
                </span>
                {!readOnly && b.items.length > 1 ? (
                  <Button size="sm" disabled={busy} onClick={() => void restore({ batchId: b.id })}>
                    {ru.projects.trashRestoreAll}
                  </Button>
                ) : null}
              </div>
              <ul className={styles.rows}>
                {b.items.map((i) => (
                  <li key={i.id} className={styles.row}>
                    <FileIcon name={i.path} size={20} />
                    <span className={styles.rowMain}>
                      <span className={styles.rowName}>{i.path}</span>
                      <span className={styles.rowMeta}>
                        {fileSize(i.bytes)}
                        {i.kind === 'previous_version' ? ` · ${ru.projects.trashPrevious}` : ''} · {ru.projects.trashUntil(fullDate(i.expiresAt))}
                      </span>
                    </span>
                    <IconButton icon="download" label={`${ru.projects.download} ${i.path}`} onClick={() => window.open(trashFileUrl(projectId, i.id), '_blank')} />
                    {readOnly ? null : (
                      <Button size="sm" disabled={busy} onClick={() => void restore({ ids: [i.id] })}>
                        {ru.projects.trashRestore}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))
        : null}
    </div>
  );
}

export function TrashDialog({ projectId, open, readOnly, onClose, onRestored }: { projectId: string; open: boolean; readOnly: boolean; onClose: () => void; onRestored: () => void }) {
  return (
    <Modal open={open} onClose={onClose} label={ru.projects.trashTitle}>
      {open ? <Trash projectId={projectId} readOnly={readOnly} onRestored={onRestored} /> : null}
    </Modal>
  );
}
