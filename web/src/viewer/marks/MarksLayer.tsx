// The layer of marks over the pages (spec, section 8.32): one transparent layer inside the scrolled area of the view,
// a picture of marks over each page — not inside the pages: PDF.js clears its pages of everything not its own when
// the scale changes. With a tool chosen, pages take the pointer: one finger or the mouse draws, two fingers move the
// pages (and scale them — zoom.ts listens on the scrolled area); a figure drawn lets the tool go. Without a tool,
// links open and text is selected — and selected text becomes a mark by itself (highlight.ts).
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ru } from '../../i18n/ru.ts';
import { cx } from '../../ui/Button.tsx';
import { badgeAt, badgeRadius, clampShare, isMarkTooSmall, markPath, strokeWidth } from './geometry.ts';
import { selectionMark } from './highlight.ts';
import type { Mark, MarkKind, MarkTool, PageBox, Point } from './types.ts';
import { useMarks } from './use-marks.ts';
import styles from './marks.module.css';

// The pen keeps a new point only after the pointer moved this far (points of the screen): a line stays light.
const PEN_STEP = 2;
// On a touch screen text is selected by handles, with no release of a pointer: the selection is taken once it has
// not changed for this long.
const TOUCH_SELECTION_SETTLED_MS = 800;
const TOUCH_SCREEN = '(hover: none)';

interface Drawing {
  pointerId: number;
  page: PageBox;
  // The picture of the page drawn on: where it is on the screen now — the area may scroll while drawing.
  surface: SVGSVGElement;
  tool: MarkTool;
  points: Point[];
}

function pointOn(surface: Element, event: { clientX: number; clientY: number }): Point {
  const rect = surface.getBoundingClientRect();
  return { x: clampShare((event.clientX - rect.left) / rect.width), y: clampShare((event.clientY - rect.top) / rect.height) };
}

function MarkShape({ mark, number, box, selected, onOpen }: { mark: Pick<Mark, 'points'> & { tool: MarkKind; id?: string }; number: number | null; box: PageBox; selected?: boolean; onOpen?: () => void }) {
  const path = markPath(mark, box.width, box.height);
  const line = strokeWidth(box.width);
  const radius = badgeRadius(box.width);
  const at = badgeAt(mark);
  // Selected text is filled, as with a marker; the drawn marks are lines.
  const marker = mark.tool === 'highlight';
  const open = onOpen
    ? {
        onPointerDown: (event: ReactPointerEvent) => event.stopPropagation(),
        onClick: onOpen,
      }
    : {};
  return (
    <g className={cx(styles.mark, onOpen && styles.markActive, selected && styles.markSelected)} data-mark-id={mark.id} {...open}>
      {onOpen && !marker ? <path d={path} className={styles.hit} strokeWidth={line * 5} data-mark-hit /> : null}
      {marker ? <path d={path} className={styles.marker} data-mark-line data-marker /> : <path d={path} className={styles.line} strokeWidth={selected ? line * 1.6 : line} data-mark-line />}
      {number !== null ? (
        <g className={styles.badge}>
          <circle cx={at.x * box.width} cy={at.y * box.height} r={radius} />
          <text x={at.x * box.width} y={at.y * box.height} fontSize={radius * 1.15} dy="0.36em">
            {number}
          </text>
        </g>
      ) : null}
    </g>
  );
}

export function MarksLayer({ pages, scroller }: { pages: readonly PageBox[]; scroller: () => HTMLElement | null }) {
  const marks = useMarks();
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const drawingRef = useRef<Drawing | null>(null);
  // Fingers on the layer: two of them move the pages instead of drawing.
  const fingers = useRef(new Map<number, { x: number; y: number }>());
  // The latest «add» of the marks, for a drawing that ends after renders since it began.
  const add = useRef(marks?.add);
  useLayoutEffect(() => {
    add.current = marks?.add;
  });
  // Stops listening to the pointer of the drawing under way.
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  const area = useRef(scroller);
  useLayoutEffect(() => {
    area.current = scroller;
  });

  // Text selected in the pages while «Пометки» is on and no tool is chosen becomes a mark: after the release of the
  // mouse; on a touch screen — once the handles stopped moving.
  const active = marks?.active ?? false;
  const choosing = Boolean(marks?.tool);
  useEffect(() => {
    if (!active || choosing) return;
    let settle = 0;
    const take = () => {
      const pages = area.current();
      const selection = window.getSelection();
      const found = pages ? selectionMark(selection, pages) : null;
      if (!found) return;
      selection?.removeAllRanges();
      add.current?.({ page: found.page, tool: 'highlight', points: found.points, text: found.text });
    };
    const released = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') window.setTimeout(take);
    };
    const changed = () => {
      if (!window.matchMedia(TOUCH_SCREEN).matches) return;
      window.clearTimeout(settle);
      settle = window.setTimeout(take, TOUCH_SELECTION_SETTLED_MS);
    };
    document.addEventListener('pointerup', released);
    document.addEventListener('selectionchange', changed);
    return () => {
      window.clearTimeout(settle);
      document.removeEventListener('pointerup', released);
      document.removeEventListener('selectionchange', changed);
    };
  }, [active, choosing]);

  // The pointer is listened to from the very press: a quick stroke — the press, the moves and the release within one
  // frame — would end before an effect began to listen, and the drawing would hang.
  const follow = (pointerId: number) => {
    const move = (event: PointerEvent) => {
      const current = drawingRef.current;
      if (!current || event.pointerId !== pointerId) return;
      const point = pointOn(current.surface, event);
      const last = current.points.at(-1)!;
      let next: Point[];
      if (current.tool === 'pen') {
        const far = Math.hypot((point.x - last.x) * current.page.width, (point.y - last.y) * current.page.height) >= PEN_STEP;
        if (!far) return;
        next = [...current.points, point];
      } else next = [current.points[0]!, point];
      drawingRef.current = { ...current, points: next };
      setDrawing(drawingRef.current);
    };
    const end = (event: PointerEvent) => {
      const current = drawingRef.current;
      if (!current || event.pointerId !== pointerId) return;
      stop.current?.();
      drawingRef.current = null;
      setDrawing(null);
      if (event.type === 'pointercancel') return;
      // The release itself is a point of the line: a stroke quicker than a move ends where the pointer was let go.
      const release = pointOn(current.surface, event);
      const points = current.tool === 'pen' ? [...current.points, release] : [current.points[0]!, release];
      if (isMarkTooSmall(points, current.page)) return;
      add.current?.({ page: current.page.page, tool: current.tool, points });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    stop.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      stop.current = null;
    };
  };

  if (!marks) return null;
  const { tool } = marks;

  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!tool) return;
    if (event.pointerType === 'touch') {
      // The first finger of a new touch: fingers lifted off the layer, where it did not hear them, are forgotten.
      if (event.isPrimary) fingers.current.clear();
      fingers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      // A second finger: no drawing, the pages move under the two.
      if (fingers.current.size > 1) {
        stop.current?.();
        drawingRef.current = null;
        setDrawing(null);
        return;
      }
    } else if (event.button !== 0) return;
    const target = (event.target as Element).closest<SVGSVGElement>('svg[data-page]');
    const page = pages.find((p) => String(p.page) === target?.dataset.page);
    if (!target || !page) return;
    event.preventDefault();
    stop.current?.();
    drawingRef.current = { pointerId: event.pointerId, page, surface: target, tool, points: [pointOn(target, event)] };
    setDrawing(drawingRef.current);
    follow(event.pointerId);
  };
  const fingerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const before = fingers.current.get(event.pointerId);
    if (!before) return;
    // Kept up to date with one finger too: a second one moves the pages from where the first is now.
    fingers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (fingers.current.size < 2) return;
    // The middle of the two fingers moves half of what one finger moves.
    scroller()?.scrollBy(-(event.clientX - before.x) / 2, -(event.clientY - before.y) / 2);
  };
  const fingerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    fingers.current.delete(event.pointerId);
  };

  const withMarks = new Set(marks.marks.map((m) => m.page));
  // While a tool is chosen every page is a surface to draw on; otherwise only pages with marks have a layer.
  const shown = pages.filter((p) => tool || withMarks.has(p.page) || drawing?.page.page === p.page);
  return (
    <div
      className={cx(styles.layer, tool && styles.drawing)}
      onPointerDown={down}
      onPointerMove={fingerMove}
      onPointerUp={fingerUp}
      onPointerCancel={fingerUp}
    >
      {shown.map((box) => (
        <svg
          key={box.page}
          data-page={box.page}
          className={styles.page}
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
          viewBox={`0 0 ${box.width} ${box.height}`}
          aria-hidden={!active}
        >
          {marks.marks.map((mark, i) =>
            mark.page === box.page ? (
              <MarkShape
                key={mark.id}
                mark={mark}
                number={i + 1}
                box={box}
                selected={marks.selected === mark.id}
                {...(active && !tool ? { onOpen: () => marks.select(mark.id) } : {})}
              />
            ) : null,
          )}
          {drawing && drawing.page.page === box.page ? <MarkShape mark={drawing} number={null} box={box} /> : null}
        </svg>
      ))}
      <span className="visually-hidden" aria-live="polite">
        {tool ? ru.marks.tool(tool) : ''}
      </span>
    </div>
  );
}
