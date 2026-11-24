// More than six files of the next message gather into one card (decision of the owner 17.11): a stack of
// sheets with the icons of the first kinds, «9 файлов» and what kinds they are — «4 Word · 2 PDF · 1 PNG»,
// or how many are still going up. A click opens the list of the files beneath, each with its size and a
// cross, and «Убрать все»; a cross on the card itself would take all of them at one slip, so there is none.
// A file taken away turns to sand like a chip (request of the owner 18.11) and the rest glide up into its
// place; «Убрать все» turns the whole card to sand.
import type { UploadedFile } from '@bba/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { useContext, useId, useState, type Ref } from 'react';
import { ru } from '../i18n/ru.ts';
import { Button, cx, IconButton } from '../ui/Button.tsx';
import { FileIcon } from '../ui/FileIcon.tsx';
import { fileStackClass, FileStackHead, kindsLine } from '../ui/FileStack.tsx';
import { turnToSand } from '../ui/dissolve.ts';
import { ChatExtrasContext } from '../answer/chat-context.ts';
import { peekOf, useImagePeek } from './image-peek.tsx';
import { fileSize } from '../i18n/format.ts';
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
  // A row of a picture shows it on hovering (image-peek.tsx).
  const { bind, peek } = useImagePeek(useContext(ChatExtrasContext)?.threadId ?? null);
  const names = files.map((f) => f.name);
  const total = files.length + uploading.length;
  return (
    <motion.div
      ref={ref}
      className={cx(fileStackClass, styles.stackPlace)}
      data-file-stack
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
            {peek}
            <motion.ul layoutScroll className={`${styles.stackList} scroll-thin`} aria-label={ru.chat.attachedFiles} {...bind}>
              <AnimatePresence mode="popLayout" initial={false}>
                {files.map((f) => (
                  <motion.li key={f.path} layout className={styles.stackRow} exit={{ opacity: 0 }} {...peekOf(f.name, f.path)}>
                    <FileIcon name={f.name} />
                    <FileName name={f.name} />
                    <span className={styles.stackSize}>{fileSize(f.bytes)}</span>
                    <IconButton
                      icon="x"
                      size="sm"
                      label={`${ru.chat.removeAttachment} ${f.name}`}
                      onClick={(e) => {
                        turnToSand(e.currentTarget.closest('li'));
                        onRemove(f.path);
                      }}
                    />
                  </motion.li>
                ))}
                {uploading.map((f) => (
                  <motion.li key={`up:${f.id}`} layout className={styles.stackRow} role="status" exit={{ opacity: 0 }}>
                    <FileRing progress={progress} id={f.id} />
                    <span className={styles.chipName}>{ru.chat.uploadingName(f.name)}</span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </motion.ul>
            <div className={styles.stackActions}>
              <Button
                size="sm"
                variant="ghost"
                onClick={(e) => {
                  turnToSand(e.currentTarget.closest('[data-file-stack]'));
                  onRemoveAll();
                }}
              >
                {ru.chat.removeAll}
              </Button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}
