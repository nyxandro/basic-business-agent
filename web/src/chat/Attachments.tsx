// The files of the next message above the input, the voice line and the file on its way up. A file
// taken away by its cross turns to sand, and the chips after it slide into its place — on another
// row too — while the input changes its height smoothly (decision of the owner 15.11). With «уменьшить
// движение» in the system the file simply goes, as every animation of the interface does.
// The chips lie in full rows (chip-rows.ts, decision of the owner 17.11): measured as drawn, broken
// into rows, every row but the last stretched to the width.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { ru } from '../i18n/ru.ts';
import { IconButton } from '../ui/Button.tsx';
import type { WaitingFile } from './attach.ts';
import { dissolve } from '../ui/dissolve.ts';
import { FileIcon } from '../ui/FileIcon.tsx';
import { useChatExtras } from './chat-context.ts';
import { chipMin, chipRows, chipWidths, type ChipSize } from './chip-rows.ts';
import styles from './chat.module.css';

// The sand is already flying when the gap starts to close.
const GAP_CLOSES_AFTER_MS = 220;
const SLIDE_MS = 320;
const SLIDE_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
// The end of a name cut in the middle stays: «Отчёт (2).docx» and «Отчёт.docx» are told apart when both
// are longer than the row. It is the last word before the extension (after a space, «_» or «-») when
// that word is short, otherwise its last letters.
const NAME_TAIL_WORD = 12;
const NAME_TAIL_LETTERS = 6;

function tailStart(name: string): number {
  const dot = name.lastIndexOf('.');
  const stemEnd = dot > 0 ? dot : name.length;
  const stem = name.slice(0, stemEnd);
  const cut = Math.max(stem.lastIndexOf(' '), stem.lastIndexOf('_'), stem.lastIndexOf('-'));
  return cut > 0 && stemEnd - cut <= NAME_TAIL_WORD ? cut : Math.max(0, stemEnd - NAME_TAIL_LETTERS);
}

// A name cut in the middle when it does not fit: its start shrinks to «…», its end stays.
function FileName({ name }: { name: string }) {
  const start = tailStart(name);
  return (
    <span className={styles.chipName} title={name} data-chip-name>
      <span className={styles.chipNameHead}>{name.slice(0, start)}</span>
      <span className={styles.chipNameTail}>{name.slice(start)}</span>
    </span>
  );
}

const CHIP_GAP_PX = 6;

interface Layout {
  sizes: ChipSize[];
  ends: number[];
  // What each chip starts from in its row (chipWidths): the browser breaks the rows by it.
  widths: number[];
}

const sameLayout = (a: Layout | null, b: Layout) =>
  a !== null && a.ends.join() === b.ends.join() && a.widths.join() === b.widths.join();

// A chip with its whole name, whatever width it is drawn at now (stretched or cut): its padding, border
// and the gaps, the icon and the cross as they are, and the full width of the name.
function naturalWidth(chip: HTMLElement): number {
  const css = getComputedStyle(chip);
  const parts = [...chip.children] as HTMLElement[];
  let width = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, key) => sum + parseFloat(css.getPropertyValue(key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))), 0);
  width += (parseFloat(css.columnGap) || 0) * Math.max(0, parts.length - 1);
  for (const part of parts) {
    if (!part.hasAttribute('data-chip-name')) width += part.getBoundingClientRect().width;
    else width += [...part.children].reduce((sum, piece) => sum + (piece as HTMLElement).scrollWidth, 0) || part.scrollWidth;
  }
  return Math.ceil(width);
}

// The rows of the chips of the box, measured anew when the chips or the width change.
function useChipRows(box: RefObject<HTMLDivElement | null>, chipsKey: string): Layout | null {
  // The box is there only while there are chips: its width is watched from when it appears.
  const present = chipsKey !== '';
  const [layout, setLayout] = useState<Layout | null>(null);
  const [width, setWidth] = useState(0);
  const [fonts, setFonts] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const watcher = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    watcher.observe(el);
    // The text is measured again once the fonts of the page have come (jsdom has no font loading).
    if ('fonts' in document) void document.fonts.ready.then(() => setFonts((n) => n + 1));
    return () => watcher.disconnect();
  }, [box, present]);
  useLayoutEffect(() => {
    const el = box.current;
    // Not laid out (a hidden tab, tests): the chips lie as they are.
    if (!el || el.clientWidth === 0) return;
    const sizes = [...el.querySelectorAll<HTMLElement>('[data-chip]')].map((chip) => {
      const natural = naturalWidth(chip);
      return { natural, min: chipMin(natural) };
    });
    const ends = chipRows(sizes, el.clientWidth, CHIP_GAP_PX);
    const next = { sizes, ends, widths: chipWidths(sizes, ends, el.clientWidth, CHIP_GAP_PX) };
    // Measuring what is drawn and laying it out before the paint is what a layout effect is for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLayout((prev) => (sameLayout(prev, next) ? prev : next));
  }, [box, chipsKey, width, fonts]);
  return layout;
}

export function Attachments({ uploading, voice }: { uploading: readonly WaitingFile[]; voice: ReactNode }) {
  const extras = useChatExtras();
  const row = useRef<HTMLDivElement>(null);
  const chipsKey = [...extras.attachments.map((f) => f.path), ...uploading.map((f) => `up:${f.id}`)].join('\n');
  const layout = useChipRows(row, chipsKey);
  const count = extras.attachments.length + uploading.length;
  // The place of a chip in the rows: its size, whether its row is stretched, whether a row ends after it.
  const placed = (i: number): { style: CSSProperties | undefined; breakAfter: boolean } => {
    const width = layout && layout.widths.length === count ? layout.widths[i] : undefined;
    if (!layout || width === undefined) return { style: undefined, breakAfter: false };
    const lastRowStart = layout.ends.length > 1 ? layout.ends.at(-2)! + 1 : 0;
    const stretched = i < lastRowStart;
    // Grows to fill its row (every row but the last), never shrinks below what was planned.
    return { style: { flex: `${stretched ? 1 : 0} 0 ${width}px`, minWidth: 0 }, breakAfter: layout.ends.includes(i) && i !== count - 1 };
  };
  // Where the row and its chips were right before a file left it.
  const before = useRef<Map<Element, DOMRect> | null>(null);

  useLayoutEffect(() => {
    const was = before.current;
    const box = row.current;
    before.current = null;
    if (!was || !box) return;
    for (const chip of box.querySelectorAll('[data-chip]')) {
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

  if (uploading.length === 0 && extras.attachments.length === 0 && !voice) return null;

  function remove(path: string, chip: HTMLElement | null) {
    if (!chip || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return extras.removeAttachment(path);
    // The sand is only a picture: if it cannot be drawn, the file still goes.
    dissolve(chip).catch((error: unknown) => console.warn('attachment sand failed', error));
    window.setTimeout(() => {
      const box = row.current;
      before.current = box ? new Map([box, ...box.querySelectorAll('[data-chip]')].map((el) => [el, el.getBoundingClientRect()])) : null;
      extras.removeAttachment(path);
    }, GAP_CLOSES_AFTER_MS);
  }

  const files = extras.attachments.length;
  return (
    <>
      {voice}
      {count > 0 ? (
        <div ref={row} className={`${styles.chips} scroll-thin`}>
          {extras.attachments.map((f, i) => {
            const { style, breakAfter } = placed(i);
            return (
              <Fragment key={f.path}>
                <span className={styles.chip} data-chip style={style}>
                  <FileIcon name={f.name} />
                  <FileName name={f.name} />
                  <IconButton icon="x" size="sm" label={`${ru.chat.removeAttachment} ${f.name}`} onClick={(e) => remove(f.path, e.currentTarget.parentElement)} />
                </span>
                {breakAfter ? <span className={styles.chipBreak} aria-hidden="true" /> : null}
              </Fragment>
            );
          })}
          {uploading.map((file, i) => {
            const { style, breakAfter } = placed(files + i);
            return (
              <Fragment key={file.id}>
                <span className={styles.chip} data-chip style={style} role="status">
                  <span className={styles.spin} />
                  <span className={styles.chipName} data-chip-name>
                    {ru.chat.uploadingName(file.name)}
                  </span>
                </span>
                {breakAfter ? <span className={styles.chipBreak} aria-hidden="true" /> : null}
              </Fragment>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
