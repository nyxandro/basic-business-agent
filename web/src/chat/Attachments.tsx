// The files of the next message above the input, the voice line and the files on their way up.
// The chips lie in full rows (chip-rows.ts, decision of the owner 17.11): measured as drawn, broken
// into rows, every row but the last stretched to the width to the pixel — so the next chip wraps by
// itself, no break element is needed (Motion keeps leaving elements for their moment, and old breaks
// kept in the flow broke every row, 17.11); a file gone lets the rows from its own on
// pack anew, as a paragraph reflows. How they get there is Motion's (decision of the owner 17.11: our
// own animation of the widths broke the rows mid-way): each chip takes its new place and width at once
// and is shown moving there by a shift and a scale, which never lays the rows out again. A file taken
// away turns to sand (decision of the owner 15.11) and leaves the flow at once; a file come fades in.
// More than six files gather into one card (AttachmentStack.tsx). The height of it all follows over the
// same moment (AutoHeight), so the input above the feed glides, not jumps. With «уменьшить движение» in
// the system everything simply takes its place.
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AutoHeight } from '../ui/AutoHeight.tsx';
import { ru } from '../i18n/ru.ts';
import { IconButton } from '../ui/Button.tsx';
import { turnToSand } from '../ui/dissolve.ts';
import { EASING, MOVE_S } from '../ui/motion.ts';
import { FileIcon } from '../ui/FileIcon.tsx';
import type { WaitingFile } from './attach.ts';
import { AttachmentStack, MAX_CHIPS } from './AttachmentStack.tsx';
import type { UploadProgress } from './upload-progress.ts';
import { FileRing } from './UploadRing.tsx';
import { useChatExtras } from './chat-context.ts';
import { chipMin, chipWidths, stableRows, type ChipSize } from './chip-rows.ts';
import { FileName } from './FileName.tsx';
import styles from './attachments.module.css';

const MOVE_MS = MOVE_S * 1000;
const CHIP_GAP_PX = 6;
const CHIP_RADIUS_PX = 10;
const stillMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// A chip with its whole name, whatever width it is drawn at now (stretched or cut, or mid-way of a
// move): its padding, border and the gaps, the icon and the cross as laid out, and the full width of
// the name. Layout sizes, not boxes on the screen: a move's scale must not change what is measured.
function naturalWidth(chip: HTMLElement): number {
  const css = getComputedStyle(chip);
  const parts = [...chip.children] as HTMLElement[];
  let width = parseFloat(css.paddingLeft) + parseFloat(css.paddingRight) + parseFloat(css.borderLeftWidth) + parseFloat(css.borderRightWidth);
  width += (parseFloat(css.columnGap) || 0) * Math.max(0, parts.length - 1);
  for (const part of parts) {
    if (!part.hasAttribute('data-chip-name')) width += part.offsetWidth;
    else width += [...part.children].reduce((sum, piece) => sum + (piece as HTMLElement).scrollWidth, 0) || part.scrollWidth;
  }
  return Math.ceil(width);
}

interface Layout {
  // The width the rows were laid out for: another width lays them out anew.
  width: number;
  rows: string[][];
  widths: ReadonlyMap<string, number>;
}

const chipsOf = (box: HTMLElement) => [...box.querySelectorAll<HTMLElement>('[data-chip]')];

// The rows of the chips of the box, laid out anew when the chips or the width change, keeping what stays;
// there is no scroll bar while the chips move.
function useChipLayout(box: RefObject<HTMLDivElement | null>, ids: readonly string[]): Layout | null {
  const key = ids.join('\n');
  const [layout, setLayout] = useState<Layout | null>(null);
  const [width, setWidth] = useState(0);
  const [fonts, setFonts] = useState(0);
  // The layout drawn now, for the next one to keep what stays.
  const drawn = useRef<Layout | null>(null);
  useLayoutEffect(() => {
    drawn.current = layout;
  });
  // The moves under way: the scroll bar comes back when the last of them ends, not an earlier one.
  const moving = useRef(0);
  // The box is there only while there are chips: its width is watched from when it appears.
  const present = key !== '';
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
    const boxWidth = Math.floor(el.clientWidth);
    const list = key.split('\n');
    const sizes = new Map<string, ChipSize>();
    // A chip leaving (its sand flying) is still in the box for a moment: it is not laid out.
    for (const chip of chipsOf(el)) {
      if (!list.includes(chip.dataset.chip!)) continue;
      const natural = naturalWidth(chip);
      sizes.set(chip.dataset.chip!, { natural, min: chipMin(natural) });
    }
    const measured = list.filter((id) => sizes.has(id));
    const prev = drawn.current;
    const rows = stableRows(prev && prev.width === boxWidth ? prev.rows : null, measured, sizes, boxWidth, CHIP_GAP_PX);
    const ends = rows.reduce<number[]>((acc, row) => [...acc, (acc.at(-1) ?? -1) + row.length], []);
    const flat = rows.flat();
    const planned = chipWidths(flat.map((id) => sizes.get(id)!), ends, boxWidth, CHIP_GAP_PX);
    const widths = new Map(flat.map((id, i) => [id, planned[i]!]));
    if (prev && prev.width === boxWidth && JSON.stringify(prev.rows) === JSON.stringify(rows) && flat.every((id) => prev.widths.get(id) === widths.get(id))) return;
    // Measuring what is drawn and laying it out before the paint is what a layout effect is for.
    setLayout({ width: boxWidth, rows, widths });
  }, [box, key, width, fonts]);

  // No scroll bar while the chips move to their new places.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || stillMotion()) return;
    const turn = ++moving.current;
    el.setAttribute('data-moving', '');
    window.setTimeout(() => {
      if (moving.current === turn) el.removeAttribute('data-moving');
    }, MOVE_MS + 60);
  }, [box, layout, key]);

  return layout;
}

export function Attachments({ uploading, progress, voice }: { uploading: readonly WaitingFile[]; progress: UploadProgress; voice: ReactNode }) {
  const extras = useChatExtras();
  const row = useRef<HTMLDivElement>(null);
  const ids = [...extras.attachments.map((f) => f.path), ...uploading.map((f) => `up:${f.id}`)];
  const layout = useChipLayout(row, ids);

  function remove(path: string, chip: HTMLElement | null) {
    turnToSand(chip);
    extras.removeAttachment(path);
  }

  const chip = (id: string, content: ReactNode, status?: boolean) => {
    const width = layout?.widths.get(id);
    return (
      <motion.span
        key={id}
        layout
        className={styles.chip}
        data-chip={id}
        style={{ borderRadius: CHIP_RADIUS_PX, ...(width === undefined ? {} : { flex: 'none', width }) }}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0 }}
        {...(status ? { role: 'status' } : {})}
      >
        {content}
      </motion.span>
    );
  };

  const chips = (
    <motion.div
      key="chips"
      ref={row}
      layoutRoot
      layoutScroll
      className={`${styles.chips} scroll-thin`}
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
              {extras.attachments.map((f) =>
                chip(
                  f.path,
                  <>
                    <motion.span layout="position" className={styles.chipPart}>
                      <FileIcon name={f.name} />
                    </motion.span>
                    <FileName name={f.name} />
                    <motion.span layout="position" className={styles.chipPart}>
                      <IconButton icon="x" size="sm" label={`${ru.chat.removeAttachment} ${f.name}`} onClick={(e) => remove(f.path, e.currentTarget.closest<HTMLElement>('[data-chip]'))} />
                    </motion.span>
                  </>,
                ),
              )}
              {uploading.map((file) =>
                chip(
                  `up:${file.id}`,
                  <>
                    <motion.span layout="position" className={styles.chipPart}>
                      <FileRing progress={progress} id={file.id} />
                    </motion.span>
                    <motion.span layout="position" className={styles.chipName} data-chip-name>
                      {ru.chat.uploadingName(file.name)}
                    </motion.span>
                  </>,
                  true,
                ),
              )}
      </AnimatePresence>
    </motion.div>
  );

  // Always there, so the first file grows the box too instead of popping in.
  return (
    <>
      {voice}
      <MotionConfig reducedMotion="user" transition={{ duration: MOVE_S, ease: EASING }}>
        <AutoHeight>
          <AnimatePresence mode="popLayout" initial={false}>
            {ids.length > MAX_CHIPS ? (
              <AttachmentStack key="stack" files={extras.attachments} uploading={uploading} progress={progress} onRemove={extras.removeAttachment} onRemoveAll={extras.clearAttachments} />
            ) : ids.length > 0 ? (
              chips
            ) : null}
          </AnimatePresence>
        </AutoHeight>
      </MotionConfig>
    </>
  );
}
