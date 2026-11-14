// «Файлы проекта» (spec, scenario 6): upload, download, removal with a question. A failed upload
// stays as a line with «Повторить». Attachments of the project's conversations land here too.
import { MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS } from '@bba/contracts';
import { useCallback, useRef, useState } from 'react';
import { ApiRequestError, asApiError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button, IconButton } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { fileSize } from '../ui/format.ts';
import { Icon } from '../ui/Icon.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { deleteProjectFile, fetchProjectFiles, projectFileUrl, uploadProjectFile } from './api.ts';
import styles from './projects.module.css';

const TOO_LARGE = 'APP_UPLOAD_TOO_LARGE';

export function ProjectFiles({ projectId }: { projectId: string }) {
  const load = useCallback(() => fetchProjectFiles(projectId), [projectId]);
  const { state, reload } = useLoad(load);
  const input = useRef<HTMLInputElement>(null);
  const [failed, setFailed] = useState<{ file: File; error: ApiRequestError } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const confirm = useConfirm();

  async function upload(file: File) {
    setFailed(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setFailed({ file, error: new ApiRequestError({ code: TOO_LARGE, message: ru.chat.tooLarge, status: 0 }) });
      return;
    }
    setBusy(file.name);
    try {
      await uploadProjectFile(projectId, file);
      reload();
    } catch (raw) {
      setFailed({ file, error: asApiError(raw) });
    } finally {
      setBusy(null);
    }
  }

  async function remove(path: string) {
    if (!(await confirm({ title: ru.projects.removeFileTitle(path), text: ru.projects.removeFileText, confirmLabel: ru.projects.remove, danger: true }))) return;
    setError(null);
    try {
      await deleteProjectFile(projectId, path);
      reload();
    } catch (raw) {
      setError(asApiError(raw));
    }
  }

  return (
    <Card className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{ru.projects.files}</h2>
        <input
          ref={input}
          type="file"
          hidden
          accept={UPLOAD_EXTENSIONS.join(',')}
          aria-label={ru.projects.upload}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (file) void upload(file);
          }}
        />
        <Button icon="clip" onClick={() => input.current?.click()} disabled={busy !== null}>
          {ru.projects.upload}
        </Button>
      </div>
      {error ? <ErrorBanner error={error} /> : null}
      {state.status === 'loading' ? <Skeleton rows={2} /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? (
        <ul className={styles.rows}>
          {busy ? (
            <li className={styles.row} role="status">
              <Icon name="file" size={16} />
              <span className={styles.rowMain}>
                <span className={styles.rowName}>{busy}</span>
                <span className={styles.rowMeta}>{ru.chat.uploadingName(busy)}</span>
              </span>
            </li>
          ) : null}
          {failed ? (
            <li className={styles.row} role="alert">
              <Icon name="alert" size={16} />
              <span className={styles.rowMain}>
                <span className={`${styles.rowName} ${styles.rowBad}`}>{ru.projects.uploadFailed(failed.file.name)}</span>
                <span className={styles.rowMeta}>
                  {failed.error.message} · {failed.error.code}
                </span>
              </span>
              {/* The same file over the limit fails again: no repeat for it. */}
              {failed.error.code === TOO_LARGE ? null : (
                <Button size="sm" onClick={() => void upload(failed.file)}>
                  {ru.projects.retry}
                </Button>
              )}
            </li>
          ) : null}
          {state.data.files.map((f) => (
            <li key={f.path} className={styles.row}>
              <Icon name="file" size={16} />
              <span className={styles.rowMain}>
                <a className={styles.rowName} href={projectFileUrl(projectId, f.path)} download>
                  {f.path}
                </a>
                <span className={styles.rowMeta}>{fileSize(f.bytes)}</span>
              </span>
              <IconButton icon="download" label={`${ru.projects.download} ${f.path}`} onClick={() => window.open(projectFileUrl(projectId, f.path), '_blank')} />
              <IconButton icon="trash" label={`${ru.projects.remove} ${f.path}`} onClick={() => void remove(f.path)} />
            </li>
          ))}
          {state.data.files.length === 0 && !busy && !failed ? <li className={styles.empty}>{ru.projects.noFiles}</li> : null}
        </ul>
      ) : null}
    </Card>
  );
}
