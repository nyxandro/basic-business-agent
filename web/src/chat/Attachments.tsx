// The files of the next message above the input, the voice line and the files on their way up.
// The chips lie in full rows (chip-rows.ts, decision of the owner 17.11): measured as drawn, broken
// into rows, every row but the last stretched to the width. They move as little and as softly as they
// can (the owner, 17.11: «слишком прыгает»): a file taken away turns to sand while its chip narrows to
// nothing (decision of the owner 15.11), the rest of its row widens to fill it, the other rows stay;
// a file come lies in the last row and fades in; widths and places change over a moment, not at once.
// With «уменьшить движение» in the system everything simply takes its place.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ReactNode } from 'react';
import { ru } from '../i18n/ru.ts';
import { IconButton } from '../ui/Button.tsx';
import { dissolve } from '../ui/dissolve.ts';
import { FileIcon } from '../ui/FileIcon.tsx';
import type { WaitingFile } from './attach.ts';
import { useChatExtras } from './chat-context.ts';
import { chipMin, chipWidths, stableRows, type ChipSize } from './chip-rows.ts';
import styles from './chat.module.css';

// The sand flies while the chip narrows; then the file goes. A soft start and end: a sharp ease-out
// moved a wide chip by a hundred pixels in its first frame (stand, 17.11).
const COLLAPSE_MS = 300;
const MOVE_MS = 360;
const EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';
const CHIP_GAP_PX = 6;
// The end of a name cut in the middle stays: «Отчёт (2).docx» and «Отчёт.docx» are told apart when both
// are longer than the row. It is the last word before the extension (after a space, «_» or «-») when
// that word is short, otherwise its last letters.
const NAME_TAIL_WORD = 12;
const NAME_TAIL_LETTERS = 6;

const stillMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

// A chip with its whole name, whatever width it is drawn at now (stretched or cut): its padding, border
// and the gaps, the icon and the cross as they are, and the full width of the name.
function naturalWidth(chip: HTMLElement): number {
  const css = getComputedStyle(chip);
  const parts = [...chip.children] as HTMLElement[];
  let width = parseFloat(css.paddingLeft) + parseFloat(css.paddingRight) + parseFloat(css.borderLeftWidth) + parseFloat(css.borderRightWidth);
  width += (parseFloat(css.columnGap) || 0) * Math.max(0, parts.length - 1);
  for (const part of parts) {
    if (!part.hasAttribute('data-chip-name')) width += part.getBoundingClientRect().width;
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

// Where the chips were before the layout changed: they move from there.
interface Before {
  rects: Map<string, DOMRect>;
  height: number;
}

const CHIP_MARGIN_PX = 3;
// The fold of a file taken away: kept while the layout moves the rest.
const FOLD_ID = 'chip-fold';

const chipsOf = (box: HTMLElement) => [...box.querySelectorAll<HTMLElement>('[data-chip]')];
// The moves of an element (jsdom has none).
const movesOf = (el: HTMLElement, subtree: boolean): Animation[] => (typeof el.getAnimations === 'function' ? el.getAnimations({ subtree }) : []);

// The rows of the chips of the box, laid out anew when the chips or the width change, keeping what stays.
function useChipLayout(box: RefObject<HTMLDivElement | null>, ids: readonly string[]): { layout: Layout | null; still: (ms: number) => void } {
  const key = ids.join('\n');
  const [layout, setLayout] = useState<Layout | null>(null);
  const [width, setWidth] = useState(0);
  const [fonts, setFonts] = useState(0);
  const before = useRef<Before | null>(null);
  // The layout drawn now, for the next one to keep what stays, and the box's height as painted: a file
  // come is already in the box when it is measured, so the box grows from the height it had (a row
  // folded away has already brought the box down: the lower of the two is where it starts).
  const drawn = useRef<Layout | null>(null);
  const paintedHeight = useRef<number | null>(null);
  // The moves under way: the scroll bar comes back when the last of them ends, not an earlier one.
  const moving = useRef(0);
  useLayoutEffect(() => {
    drawn.current = layout;
  });
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
    const sizes = new Map<string, ChipSize>();
    for (const chip of chipsOf(el)) {
      const natural = naturalWidth(chip);
      sizes.set(chip.dataset.chip!, { natural, min: chipMin(natural) });
    }
    const list = key.split('\n').filter((id) => sizes.has(id));
    const prev = drawn.current;
    const rows = stableRows(prev && prev.width === boxWidth ? prev.rows : null, list, sizes, boxWidth, CHIP_GAP_PX);
    const ends = rows.reduce<number[]>((acc, row) => [...acc, (acc.at(-1) ?? -1) + row.length], []);
    const flat = rows.flat();
    const planned = chipWidths(flat.map((id) => sizes.get(id)!), ends, boxWidth, CHIP_GAP_PX);
    const widths = new Map(flat.map((id, i) => [id, planned[i]!]));
    if (prev && prev.width === boxWidth && JSON.stringify(prev.rows) === JSON.stringify(rows) && flat.every((id) => prev.widths.get(id) === widths.get(id))) return;
    // Where every chip is now — as drawn before this change — so it can move from there.
    // The box's height on the screen: mid-way of its own move, as it is; otherwise as last painted, unless a
    // row folded away has already brought it lower (a file come is in the box already, a row gone is not).
    const now = el.getBoundingClientRect().height;
    const shown = movesOf(el, false).length > 0 ? now : Math.min(paintedHeight.current ?? Infinity, now);
    before.current = stillMotion() ? null : { rects: new Map(chipsOf(el).map((chip) => [chip.dataset.chip!, chip.getBoundingClientRect()])), height: shown };
    // Measuring what is drawn and laying it out before the paint is what a layout effect is for.
    setLayout({ width: boxWidth, rows, widths });
  }, [box, key, width, fonts]);

  // The chips move from where they were: a new width over a moment, another row by sliding there.
  useLayoutEffect(() => {
    const was = before.current;
    const el = box.current;
    before.current = null;
    if (!el) return;
    // Where everything comes to — not mid-way of a move still going: that move gives way to this one (it
    // started from where it was on the screen). The fold of a file going and a file fading in go on.
    for (const move of movesOf(el, true)) if (move.id !== FOLD_ID && !(move instanceof CSSAnimation)) move.cancel();
    paintedHeight.current = el.getBoundingClientRect().height;
    if (!was) return;
    const moves: Animation[] = [];
    for (const chip of chipsOf(el)) {
      const old = was.rects.get(chip.dataset.chip!);
      if (!old) continue;
      const now = chip.getBoundingClientRect();
      if (Math.abs(old.width - now.width) > 0.5) moves.push(chip.animate([{ width: `${old.width}px` }, { width: `${now.width}px` }], { duration: MOVE_MS, easing: EASING }));
      // Within its row a chip follows the widths of the ones before it; only another row is a slide.
      if (Math.abs(old.top - now.top) > 0.5) {
        moves.push(chip.animate([{ transform: `translate(${old.left - now.left}px, ${old.top - now.top}px)` }, { transform: 'none' }], { duration: MOVE_MS, easing: EASING }));
      }
    }
    const height = el.getBoundingClientRect().height;
    if (Math.abs(was.height - height) > 0.5) moves.push(el.animate([{ height: `${was.height}px` }, { height: `${height}px` }], { duration: MOVE_MS, easing: EASING }));
    if (moves.length === 0) return;
    // No scroll bar while the chips are under way.
    const turn = ++moving.current;
    el.setAttribute('data-moving', '');
    void Promise.allSettled(moves.map((move) => move.finished)).then(() => {
      if (moving.current === turn) el.removeAttribute('data-moving');
    });
  }, [box, layout]);

  // No scroll bar for a while (a file folding away), unless a move begun meanwhile holds it longer.
  const still = (ms: number) => {
    const el = box.current;
    if (!el) return;
    const turn = ++moving.current;
    el.setAttribute('data-moving', '');
    window.setTimeout(() => {
      if (moving.current === turn) el.removeAttribute('data-moving');
    }, ms);
  };

  return { layout, still };
}

export function Attachments({ uploading, voice }: { uploading: readonly WaitingFile[]; voice: ReactNode }) {
  const extras = useChatExtras();
  const row = useRef<HTMLDivElement>(null);
  const ids = [...extras.attachments.map((f) => f.path), ...uploading.map((f) => `up:${f.id}`)];
  const { layout, still } = useChipLayout(row, ids);
  // Rows end after these chips (every row but the last).
  const rowEnds = new Set((layout?.rows ?? []).slice(0, -1).map((r) => r.at(-1)!));
  const placed = (id: string) => {
    const width = layout?.widths.get(id);
    return { style: width === undefined ? undefined : { flex: 'none', width }, breakAfter: rowEnds.has(id) };
  };

  if (ids.length === 0 && !voice) return null;

  function remove(path: string, chip: HTMLElement | null) {
    if (!chip || stillMotion()) return extras.removeAttachment(path);
    // The sand is only a picture: if it cannot be drawn, the file still goes.
    dissolve(chip).catch((error: unknown) => console.warn('attachment sand failed', error));
    // The chip narrows to nothing, its gap too: the rest of its row slides in its place. Alone in its
    // row, it folds in height as well — the row goes softly and the input comes down with it.
    const alone = layout?.rows.find((r) => r.includes(path))?.length === 1;
    still(COLLAPSE_MS + MOVE_MS);
    const { width, height } = chip.getBoundingClientRect();
    const fold = alone ? { height: '0px', marginTop: '0px', marginBottom: '0px' } : {};
    chip.animate(
      [
        { width: `${width}px`, marginRight: '0px', ...(alone ? { height: `${height}px`, marginTop: `${CHIP_MARGIN_PX}px`, marginBottom: `${CHIP_MARGIN_PX}px` } : {}) },
        { width: '0px', minWidth: '0px', paddingLeft: '0px', paddingRight: '0px', borderWidth: '0px', marginRight: `-${CHIP_GAP_PX}px`, ...fold },
      ],
      { id: FOLD_ID, duration: COLLAPSE_MS, easing: EASING, fill: 'forwards' },
    );
    window.setTimeout(() => extras.removeAttachment(path), COLLAPSE_MS);
  }

  const chip = (id: string, content: ReactNode, status?: boolean) => {
    const { style, breakAfter } = placed(id);
    return (
      <Fragment key={id}>
        <span className={styles.chip} data-chip={id} style={style} {...(status ? { role: 'status' } : {})}>
          {content}
        </span>
        {breakAfter ? <span className={styles.chipBreak} aria-hidden="true" /> : null}
      </Fragment>
    );
  };

  return (
    <>
      {voice}
      {ids.length > 0 ? (
        <div ref={row} className={`${styles.chips} scroll-thin`}>
          {extras.attachments.map((f) =>
            chip(
              f.path,
              <>
                <FileIcon name={f.name} />
                <FileName name={f.name} />
                <IconButton icon="x" size="sm" label={`${ru.chat.removeAttachment} ${f.name}`} onClick={(e) => remove(f.path, e.currentTarget.parentElement)} />
              </>,
            ),
          )}
          {uploading.map((file) =>
            chip(
              `up:${file.id}`,
              <>
                <span className={styles.spin} />
                <span className={styles.chipName} data-chip-name>
                  {ru.chat.uploadingName(file.name)}
                </span>
              </>,
              true,
            ),
          )}
        </div>
      ) : null}
    </>
  );
}
