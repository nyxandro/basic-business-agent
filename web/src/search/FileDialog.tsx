// The window of a found document (spec, sections 8.21 and 8.27; decisions of the owner 16.11 and 18.11): its
// name, project, day and size, «Закрыть», «Посмотреть» — the document viewer over the window, for the files it
// shows — and «Скачать». As the file block
// of the chat, it asks first what it will find: a file removed meanwhile is said so, from the project's trash
// it can be downloaded or brought back. The window of «Поиск» stays under it.
import { previewKindOf, type SearchFile } from '@bba/contracts';
import { useCallback } from 'react';
import { FileNote } from '../genui/FileBlock.tsx';
import { ru } from '../i18n/ru.ts';
import { Button, ButtonLink } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { FileIcon } from '../ui/FileIcon.tsx';
import { dayLabel, fileSize } from '../ui/format.ts';
import { Modal } from '../ui/Modal.tsx';
import { useLoad } from '../ui/use-load.ts';
import { fetchFileStatus, filePreviewUrl, fileUrl } from './api.ts';
import { useDocumentViewer } from '../viewer/use-viewer.tsx';
import { placeOf } from './FileResult.tsx';
import styles from './search.module.css';
import { DelayedBar } from '../ui/Loading.tsx';

export function FileDialog({ file, projectName, onClose }: { file: SearchFile; projectName: string; onClose: () => void }) {
  const check = useCallback(() => fetchFileStatus(file), [file]);
  const { state, reload } = useLoad(check);
  const { open, viewer } = useDocumentViewer();
  return (
    <Modal open onClose={onClose} label={file.name} narrow>
      <div className={styles.fileDialog}>
        <div className={styles.fileHead}>
          <span className={styles.fileTile}>
            <FileIcon name={file.name} size={26} />
          </span>
          <div className={styles.fileText}>
            <h2 className={styles.fileName}>{file.name}</h2>
            <p className={styles.fileMeta}>{ru.search.fileMeta(placeOf(file, projectName), dayLabel(file.modifiedAt), fileSize(file.bytes))}</p>
          </div>
        </div>
        {state.status === 'loading' ? <DelayedBar /> : null}
        {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
        {state.status === 'ready' && state.data.state !== 'ok' ? <FileNote status={state.data} onRestored={reload} /> : null}
        <div className={styles.fileActions}>
          <Button variant="secondary" onClick={onClose}>
            {ru.search.closeFile}
          </Button>
          {state.status === 'ready' && state.data.state === 'ok' && previewKindOf(file.name) ? (
            <Button icon="eye" onClick={() => open({ name: file.name, downloadUrl: fileUrl(file), previewUrl: filePreviewUrl(file) })}>
              {ru.viewer.view}
            </Button>
          ) : null}
          {state.status === 'ready' && state.data.state === 'ok' ? (
            <ButtonLink variant="primary" href={fileUrl(file)} download={file.name} icon="download">
              {ru.genui.download}
            </ButtonLink>
          ) : null}
        </div>
      </div>
      {viewer}
    </Modal>
  );
}
