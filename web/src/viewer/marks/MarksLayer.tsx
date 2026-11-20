// The layer of marks over the pages (spec, section 8.32): one transparent layer inside the scrolled area of the view,
// a picture of marks over each page — not inside the pages: PDF.js clears its pages of everything not its own when
// the scale changes. With a tool chosen, pages take the pointer: one finger or the mouse draws, two fingers move the
// pages (and scale them — zoom.ts listens on the scrolled area). Without a tool, text is selected and links open.
import { useEffect, useEffectEvent, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ru } from '../../i18n/ru.ts';
import { cx } from '../../ui/Button.tsx';
import { badgeAt, badgeRadius, clampShare, isMarkTooSmall, markPath, strokeWidth } from './geometry.ts';
import type { Mark, MarkTool, PageBox, Point } from './types.ts';
import { useMarks } from './use-marks.ts';
import styles from './marks.module.css';

// The pen keeps a new point only after the pointer moved this far (points of the screen): a line stays light.
const PEN_STEP = 2;

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

function MarkShape({ mark, number, box, selected, onOpen }: { mark: Pick<Mark, 'tool' | 'points'> & { id?: string }; number: number | null; box: PageBox; selected?: boolean; onOpen?: () => void }) {
  const path = markPath(mark, box.width, box.height);
  const line = strokeWidth(box.width);
  const radius = badgeRadius(box.width);
  const at = badgeAt(mark);
  const open = onOpen
    ? {
        onPointerDown: (event: ReactPointerEvent) => event.stopPropagation(),
        onClick: onOpen,
      }
    : {};
  return (
    <g className={cx(styles.mark, onOpen && styles.markActive, selected && styles.markSelected)} data-mark-id={mark.id} {...open}>
      {onOpen ? <path d={path} className={styles.hit} strokeWidth={line * 5} /> : null}
      <path d={path} className={styles.line} strokeWidth={selected ? line * 1.6 : line} />
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
  const drawn = useEffectEvent((mark: { page: number; tool: MarkTool; points: Point[] }) => marks?.add(mark));

  useEffect(() => {
    if (!drawing) return;
    const move = (event: PointerEvent) => {
      const current = drawingRef.current;
      if (!current || event.pointerId !== current.pointerId) return;
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
      if (!current || event.pointerId !== current.pointerId) return;
      drawingRef.current = null;
      setDrawing(null);
      if (event.type === 'pointercancel') return;
      const points = current.tool === 'pen' ? current.points : [current.points[0]!, current.points.at(-1)!];
      if (isMarkTooSmall(points, current.page)) return;
      drawn({ page: current.page.page, tool: current.tool, points });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    // A new drawing starts the listening; its points change through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing?.pointerId]);

  if (!marks) return null;
  const { tool, active } = marks;

  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!tool) return;
    if (event.pointerType === 'touch') {
      // The first finger of a new touch: fingers lifted off the layer, where it did not hear them, are forgotten.
      if (event.isPrimary) fingers.current.clear();
      fingers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      // A second finger: no drawing, the pages move under the two.
      if (fingers.current.size > 1) {
        drawingRef.current = null;
        setDrawing(null);
        return;
      }
    } else if (event.button !== 0) return;
    const target = (event.target as Element).closest<SVGSVGElement>('svg[data-page]');
    const page = pages.find((p) => String(p.page) === target?.dataset.page);
    if (!target || !page) return;
    event.preventDefault();
    drawingRef.current = { pointerId: event.pointerId, page, surface: target, tool, points: [pointOn(target, event)] };
    setDrawing(drawingRef.current);
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
