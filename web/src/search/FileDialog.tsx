// The window of a found document (spec, section 8.21; decision of the owner 16.11): its name, project, day
// and size, «Скачать» and, for a PDF, «Посмотреть» — the browser's own viewer in a new tab. As the file block
// of the chat, it asks first what it will find: a file removed meanwhile is said so, from the project's trash
// it can be downloaded or brought back. The window of «Поиск» stays under it.
import type { SearchFile } from '@bba/contracts';
import { useCallback } from 'react';
import { FileNote } from '../genui/FileBlock.tsx';
import { ru } from '../i18n/ru.ts';
import { Button, ButtonLink } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { FileIcon } from '../ui/FileIcon.tsx';
import { dayLabel, fileSize } from '../ui/format.ts';
import { Modal } from '../ui/Modal.tsx';
import { useLoad } from '../ui/use-load.ts';
import { fetchFileStatus, fileUrl } from './api.ts';
import { placeOf } from './FileResult.tsx';
import styles from './search.module.css';

const isPdf = (name: string) => name.toLowerCase().endsWith('.pdf');

export function FileDialog({ file, projectName, onClose }: { file: SearchFile; projectName: string; onClose: () => void }) {
  const check = useCallback(() => fetchFileStatus(file), [file]);
  const { state, reload } = useLoad(check);
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
        {state.status === 'loading' ? (
          <p className={styles.fileChecking} role="status">
            <span className={styles.spin} />
            {ru.search.checkingFile}
          </p>
        ) : null}
        {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
        {state.status === 'ready' && state.data.state !== 'ok' ? <FileNote status={state.data} onRestored={reload} /> : null}
        <div className={styles.fileActions}>
          <Button variant="secondary" onClick={onClose}>
            {ru.search.closeFile}
          </Button>
          {state.status === 'ready' && state.data.state === 'ok' && isPdf(file.name) ? (
            <ButtonLink href={fileUrl(file, true)} target="_blank" rel="noopener noreferrer">
              {ru.search.view}
            </ButtonLink>
          ) : null}
          {state.status === 'ready' && state.data.state === 'ok' ? (
            <ButtonLink variant="primary" href={fileUrl(file)} download={file.name} icon="download">
              {ru.genui.download}
            </ButtonLink>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
