// More than six files of the next message gather into one card (decision of the owner 17.11): a stack of
// sheets with the icons of the first kinds, «9 файлов» and what kinds they are — «4 Word · 2 PDF · 1 PNG»,
// or how many are still going up. A click opens the list of the files beneath, each with its size and a
// cross, and «Убрать все»; a cross on the card itself would take all of them at one slip, so there is none.
import type { UploadedFile } from '@bba/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useState, type Ref } from 'react';
import { ru } from '../i18n/ru.ts';
import { Button, cx, IconButton } from '../ui/Button.tsx';
import { FileIcon, fileTypeLabel } from '../ui/FileIcon.tsx';
import { fileSize } from '../ui/format.ts';
import { Icon } from '../ui/Icon.tsx';
import type { WaitingFile } from './attach.ts';
import { FileName } from './FileName.tsx';
import styles from './attachments.module.css';
import chat from './chat.module.css';

// Files gathered into the card when there are more than this.
export const MAX_CHIPS = 6;
// Icons on the card: the first kinds of the files.
const STACK_ICONS = 3;

// «4 Word · 2 PDF · 1 PNG»: the most of a kind first, then as they came.
function kindsLine(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(fileTypeLabel(name), (counts.get(fileTypeLabel(name)) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${n} ${label}`)
    .join(' · ');
}

// The first files of different kinds, for the icons of the card.
function iconNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => (seen.has(fileTypeLabel(name)) ? false : (seen.add(fileTypeLabel(name)), true))).slice(0, STACK_ICONS);
}

export function AttachmentStack({
  files,
  uploading,
  onRemove,
  onRemoveAll,
  ref,
}: {
  files: readonly UploadedFile[];
  uploading: readonly WaitingFile[];
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
      className={styles.stack}
      initial={{ opacity: 0, scale: 0.97, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
    >
      <button type="button" className={styles.stackHead} aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
        <span className={styles.stackIcons} aria-hidden="true">
          {iconNames(names.length > 0 ? names : uploading.map((f) => f.name)).map((name) => (
            <span key={name} className={styles.stackIcon}>
              <FileIcon name={name} size={18} />
            </span>
          ))}
        </span>
        <span className={styles.stackText}>
          <span className={styles.stackTitle}>{ru.chat.filesCount(total)}</span>
          <span className={styles.stackKinds}>
            {uploading.length > 0 ? (
              <>
                <span className={chat.spin} />
                {ru.chat.uploadingMore(uploading.length)}
              </>
            ) : (
              kindsLine(names)
            )}
          </span>
        </span>
        <Icon name="down" size={16} className={cx(styles.stackChevron, open && styles.stackChevronOpen)} />
      </button>
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
                  <span className={chat.spin} />
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
