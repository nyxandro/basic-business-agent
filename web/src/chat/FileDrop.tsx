// Files dragged from the computer onto the chat window (spec, section 8.9): while they are over the
// window it shows where to drop them; dropped, they are attached to the next message as from the
// paperclip. Only files from outside the page light it up — a dragged text, link, project or a
// picture of the feed (Chrome gives it as a file too) does not. A file dropped beside the window,
// while the chat is open, is not opened by the browser in place of the app.
import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from 'react';
import { ru } from '../i18n/ru.ts';
import { Icon } from '../ui/Icon.tsx';
import { folderRefusal, type AttachFailure } from './attach.ts';
import styles from './chat.module.css';

const hasFiles = (data: DataTransfer | null) => Boolean(data && Array.from(data.types).includes('Files'));

// The dropped files and the folders among them: a folder comes as a file the browser cannot read.
// Its entry is read during the drop only — after it the browser empties the list.
function dropped(data: DataTransfer): { files: File[]; refused: AttachFailure[] } {
  const entries = Array.from(data.items ?? []).filter((item) => item.kind === 'file');
  const files: File[] = [];
  const refused: AttachFailure[] = [];
  Array.from(data.files).forEach((file, i) => {
    if (entries[i]?.webkitGetAsEntry?.()?.isDirectory) refused.push(folderRefusal(file.name));
    else files.push(file);
  });
  return { files, refused };
}

export function useFileDrop(onDrop: (files: File[], refused: AttachFailure[]) => void): { onDragEnter: (event: ReactDragEvent) => void; overlay: ReactNode } {
  const [over, setOver] = useState(false);
  // A drag that started on the page itself: it brings nothing from the computer.
  const fromPage = useRef(false);

  useEffect(() => {
    const started = () => {
      fromPage.current = true;
    };
    const ended = () => {
      fromPage.current = false;
    };
    // What the window itself took is handled; elsewhere a file is not let fall into the browser.
    const guard = (event: DragEvent) => {
      if (event.defaultPrevented || !hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.type === 'dragover') event.dataTransfer!.dropEffect = 'none';
    };
    window.addEventListener('dragstart', started);
    window.addEventListener('dragend', ended);
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragstart', started);
      window.removeEventListener('dragend', ended);
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

  const onDragEnter = (event: ReactDragEvent) => {
    if (fromPage.current || !hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    setOver(true);
  };

  // The hint covers the whole window and takes the drag itself: its insides let it through, so
  // leaving it is leaving the window, not passing from one part of it to another.
  const overlay = over ? (
    <div
      className={styles.drop}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const { files, refused } = dropped(event.dataTransfer);
        if (files.length > 0 || refused.length > 0) onDrop(files, refused);
      }}
    >
      <div className={styles.dropFrame} />
      <div className={styles.dropCard}>
        <span className={styles.dropIcon}>
          <Icon name="clip" size={26} />
        </span>
        <p className={styles.dropTitle}>{ru.chat.dropTitle}</p>
        <p className={styles.dropHint}>{ru.chat.dropHint}</p>
      </div>
    </div>
  ) : null;

  return { onDragEnter, overlay };
}
