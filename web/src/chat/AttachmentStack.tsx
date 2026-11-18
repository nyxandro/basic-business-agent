// More than six files of the next message gather into one card (decision of the owner 17.11): a stack of
// sheets with the icons of the first kinds, «9 файлов» and what kinds they are — «4 Word · 2 PDF · 1 PNG»,
// or how many are still going up. A click opens the list of the files beneath, each with its size and a
// cross, and «Убрать все»; a cross on the card itself would take all of them at one slip, so there is none.
import type { UploadedFile } from '@bba/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useState, type Ref } from 'react';
import { ru } from '../i18n/ru.ts';
import { Button, cx, IconButton } from '../ui/Button.tsx';
import { FileIcon } from '../ui/FileIcon.tsx';
import { fileStackClass, FileStackHead, kindsLine } from '../ui/FileStack.tsx';
import { fileSize } from '../ui/format.ts';
import type { WaitingFile } from './attach.ts';
import { FileName } from './FileName.tsx';
import type { UploadProgress } from './upload-progress.ts';
import { BatchProgress, FileRing } from './UploadRing.tsx';
import styles from './attachments.module.css';

// Files gathered into the card when there are more than this.
export const MAX_CHIPS = 6;

export function AttachmentStack({
  files,
  uploading,
  progress,
  onRemove,
  onRemoveAll,
  ref,
}: {
  files: readonly UploadedFile[];
  uploading: readonly WaitingFile[];
  progress: UploadProgress;
  onRemove: (path: string) => void;
  onRemoveAll: () => void;
  ref?: Ref<HTMLDivElement>;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const names = files.map((f) => f.name);
  const total = files.length + uploading.length;
  return (
    <motion.div
      ref={ref}
      className={cx(fileStackClass, styles.stackPlace)}
      initial={{ opacity: 0, scale: 0.97, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
    >
      <FileStackHead
        names={names.length > 0 ? names : uploading.map((f) => f.name)}
        title={ru.chat.filesCount(total)}
        meta={uploading.length > 0 ? <BatchProgress progress={progress} left={uploading.length} /> : kindsLine(names)}
        open={open}
        controls={listId}
        onClick={() => setOpen((o) => !o)}
      />
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div id={listId} className={styles.stackBody} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <ul className={`${styles.stackList} scroll-thin`} aria-label={ru.chat.attachedFiles}>
              {files.map((f) => (
                <li key={f.path} className={styles.stackRow}>
                  <FileIcon name={f.name} />
                  <FileName name={f.name} />
                  <span className={styles.stackSize}>{fileSize(f.bytes)}</span>
                  <IconButton icon="x" size="sm" label={`${ru.chat.removeAttachment} ${f.name}`} onClick={() => onRemove(f.path)} />
                </li>
              ))}
              {uploading.map((f) => (
                <li key={`up:${f.id}`} className={styles.stackRow} role="status">
                  <FileRing progress={progress} id={f.id} />
                  <span className={styles.chipName}>{ru.chat.uploadingName(f.name)}</span>
                </li>
              ))}
            </ul>
            <div className={styles.stackActions}>
              <Button size="sm" variant="ghost" onClick={onRemoveAll}>
                {ru.chat.removeAll}
              </Button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}
