// The file block (spec, sections 8.18, 8.20 and 8.27): a file the agent made in the folder of the
// conversation — its icon, name, size, «Открыть» (the document viewer, for what it shows) and «Скачать»; a file removed since then is said so. Drawn from the result of show_file, where the server says the file
// is there; a call that found no file draws nothing (the model is told and tries again).
import { fileBlockResultSchema, previewKindOf, type ThreadFileStatus } from '@bba/contracts';
import { useState, type MouseEvent } from 'react';
import { asApiError } from '../api/client.ts';
import { fetchThreadFileStatus, threadFilePreviewUrl, threadFileUrl } from '../chat/api.ts';
import { restoreFromTrash, trashFileUrl } from '../projects/api.ts';
import { parseToolResult } from '../chat/tool-result.ts';
import { ru } from '../i18n/ru.ts';
import { Button, ButtonLink } from '../ui/Button.tsx';
import { useDocumentViewer } from '../viewer/use-viewer.tsx';
import { FileIcon } from '../ui/FileIcon.tsx';
import { fileSize, fullDate } from '../ui/format.ts';
import { Preparing, type CallProps } from './CatalogBlock.tsx';
import styles from './genui.module.css';

function noteText(status: Exclude<ThreadFileStatus, { state: 'ok' }>): string {
  if (status.state === 'trash') return ru.genui.fileInTrash(status.name, fullDate(status.expiresAt));
  if (status.state === 'deleted') return ru.genui.fileDeleted(status.name);
  return ru.genui.fileLost[status.reason](status.projectName);
}

// «Скачать» asks first what it will find: a file removed from the folder is said so — from the
// project's trash it can be downloaded or brought back (spec, section 8.20).
export function FileNote({ status, onRestored }: { status: Exclude<ThreadFileStatus, { state: 'ok' }>; onRestored: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className={styles.fileNote} role="status">
      <p>{noteText(status)}</p>
      {status.state === 'trash' ? (
        <div className={styles.fileNoteActions}>
          <ButtonLink href={trashFileUrl(status.projectId, status.trashId)} download={status.name} icon="download" size="sm">
            {ru.genui.downloadFromTrash}
          </ButtonLink>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              restoreFromTrash(status.projectId, { ids: [status.trashId] }).then(onRestored, (raw: unknown) => (setError(asApiError(raw).message), setBusy(false)));
            }}
          >
            {ru.genui.restoreToFolder}
          </Button>
        </div>
      ) : null}
      {error ? <p className={styles.fileNoteError}>{error}</p> : null}
    </div>
  );
}

export function FileBlockView({ name, bytes, href, previewHref, checkFile }: { name: string; bytes: number; href: string; previewHref: string; checkFile: () => Promise<ThreadFileStatus> }) {
  const [note, setNote] = useState<Exclude<ThreadFileStatus, { state: 'ok' }> | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const { open, viewer } = useDocumentViewer();
  // «Открыть» and «Скачать» ask first what they will find: a file removed is said so, as before.
  async function whenThere(then: () => void) {
    setFailed(null);
    try {
      const status = await checkFile();
      if (status.state !== 'ok') return setNote(status);
      setNote(null);
      then();
    } catch (raw) {
      setFailed(asApiError(raw).message);
    }
  }
  function download(e: MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    void whenThere(() => {
      const a = document.createElement('a');
      a.href = href;
      a.download = name;
      a.click();
    });
  }
  return (
    <>
    <article className={`${styles.block} ${styles.file}`}>
      <span className={styles.fileIcon}>
        <FileIcon name={name} size={26} />
      </span>
      <div className={styles.fileText}>
        <div className={styles.fileName} title={name}>
          {name}
        </div>
        <div className={styles.fileSize}>{fileSize(bytes)}</div>
      </div>
      {previewKindOf(name) ? (
        <Button icon="eye" size="sm" className={styles.fileOpen} aria-label={ru.viewer.openFile(name)} onClick={() => void whenThere(() => open({ name, downloadUrl: href, previewUrl: previewHref }))}>
          {ru.viewer.open}
        </Button>
      ) : null}
      <ButtonLink href={href} download={name} icon="download" size="sm" className={styles.fileDownload} aria-label={ru.genui.downloadFile(name)} onClick={download}>
        {ru.genui.download}
      </ButtonLink>
    </article>
    {note ? <FileNote status={note} onRestored={() => setNote(null)} /> : null}
    {failed ? <p className={styles.fileNoteError}>{failed}</p> : null}
    {viewer}
    </>
  );
}

export function FileCall({ call, threadId }: { call: CallProps; threadId: string }) {
  if (call.status !== 'complete') return <Preparing />;
  const outcome = parseToolResult(call.result);
  if (outcome.kind !== 'ok') return null;
  const parsed = fileBlockResultSchema.safeParse(outcome.value);
  if (!parsed.success || !parsed.data.shown) return null;
  const path = parsed.data.path;
  return <FileBlockView name={parsed.data.name} bytes={parsed.data.bytes} href={threadFileUrl(threadId, path)} previewHref={threadFilePreviewUrl(threadId, path)} checkFile={() => fetchThreadFileStatus(threadId, path)} />;
}
