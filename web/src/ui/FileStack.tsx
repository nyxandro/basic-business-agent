// Several files as one card, a stack of sheets (decisions of the owner 17.11 and 18.11): the icons of the
// first kinds of its files, a title and a line under it. The files of the next message
// (chat/AttachmentStack.tsx) and the versions of one document in «Файлы проекта» (projects/ProjectFiles.tsx).
import type { ReactNode } from 'react';
import { cx } from './Button.tsx';
import { FileIcon, fileTypeLabel } from './FileIcon.tsx';
import { Icon } from './Icon.tsx';
import styles from './file-stack.module.css';

// Icons on the card: the first kinds of the files.
const STACK_ICONS = 3;

// The card; the sheets peeking out above it are drawn by this class, what is inside is the caller's.
export const fileStackClass = styles.stack;

// «4 Word · 2 PDF · 1 PNG»: the most of a kind first, then as they came.
export function kindsLine(names: readonly string[]): string {
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

export function FileStackHead({ names, title, meta, open, controls, onClick }: { names: readonly string[]; title: ReactNode; meta: ReactNode; open: boolean; controls?: string; onClick: () => void }) {
  return (
    <button type="button" className={styles.head} aria-expanded={open} aria-controls={controls} onClick={onClick}>
      <span className={styles.icons} aria-hidden="true">
        {iconNames(names).map((name) => (
          <span key={name} className={styles.icon}>
            <FileIcon name={name} size={18} />
          </span>
        ))}
      </span>
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        {/* A line of text is cut with «…»; a line of its own (the progress of an upload) is laid out by itself. */}
        <span className={styles.meta}>{typeof meta === 'string' ? <span className={styles.metaText}>{meta}</span> : meta}</span>
      </span>
      <Icon name="down" size={16} className={cx(styles.chevron, open && styles.chevronOpen)} />
    </button>
  );
}
