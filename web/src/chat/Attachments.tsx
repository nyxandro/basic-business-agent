// The files of the next message above the input, the voice line and the file on its way up. A file
// taken away by its cross turns to sand, and the chips after it slide into its place — on another
// row too — while the input changes its height smoothly (decision of the owner 15.11). With «уменьшить
// движение» in the system the file simply goes, as every animation of the interface does.
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { ru } from '../i18n/ru.ts';
import { IconButton } from '../ui/Button.tsx';
import { dissolve } from '../ui/dissolve.ts';
import { FileIcon } from '../ui/FileIcon.tsx';
import { useChatExtras } from './chat-context.ts';
import styles from './chat.module.css';

// The sand is already flying when the gap starts to close.
const GAP_CLOSES_AFTER_MS = 220;
const SLIDE_MS = 320;
const SLIDE_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

export function Attachments({ uploading, voice }: { uploading: string | null; voice: ReactNode }) {
  const extras = useChatExtras();
  const row = useRef<HTMLDivElement>(null);
  // Where the row and its chips were right before a file left it.
  const before = useRef<Map<Element, DOMRect> | null>(null);

  useLayoutEffect(() => {
    const was = before.current;
    const box = row.current;
    before.current = null;
    if (!was || !box) return;
    for (const chip of box.children) {
      const old = was.get(chip);
      if (!old) continue;
      const now = chip.getBoundingClientRect();
      const dx = old.left - now.left;
      const dy = old.top - now.top;
      if (dx !== 0 || dy !== 0) chip.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: SLIDE_MS, easing: SLIDE_EASING });
    }
    const oldHeight = was.get(box)?.height;
    const height = box.getBoundingClientRect().height;
    if (oldHeight !== undefined && oldHeight !== height) box.animate([{ height: `${oldHeight}px` }, { height: `${height}px` }], { duration: SLIDE_MS, easing: SLIDE_EASING });
  }, [extras.attachments]);

  if (!uploading && extras.attachments.length === 0 && !voice) return null;

  function remove(path: string, chip: HTMLElement | null) {
    if (!chip || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return extras.removeAttachment(path);
    // The sand is only a picture: if it cannot be drawn, the file still goes.
    dissolve(chip).catch((error: unknown) => console.warn('attachment sand failed', error));
    window.setTimeout(() => {
      const box = row.current;
      before.current = box ? new Map([box, ...box.children].map((el) => [el, el.getBoundingClientRect()])) : null;
      extras.removeAttachment(path);
    }, GAP_CLOSES_AFTER_MS);
  }

  return (
    <div ref={row} className={styles.chips}>
      {voice}
      {extras.attachments.map((f) => (
        <span key={f.path} className={styles.chip}>
          <FileIcon name={f.name} />
          <span className={styles.chipName}>{f.name}</span>
          <IconButton icon="x" size="sm" label={`${ru.chat.removeAttachment} ${f.name}`} onClick={(e) => remove(f.path, e.currentTarget.parentElement)} />
        </span>
      ))}
      {uploading ? (
        <span className={styles.chip} role="status">
          <span className={styles.spin} />
          <span className={styles.chipName}>{uploading}</span>
        </span>
      ) : null}
    </div>
  );
}
