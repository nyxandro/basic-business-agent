// The shapes of the marks (spec, section 8.32): one outline for the screen (SVG) and for the picture for the agent
// (a canvas takes the same path data through Path2D), drawn from shares of the page at any size.
import type { Mark, Point } from './types.ts';

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Smaller than this on the screen, a drawing is a press, not a mark.
export const MIN_MARK_PX = 6;

// `Math.max(0, -0)` is +0: a share never comes out as −0.
export const clampShare = (value: number): number => Math.min(1, Math.max(0, value));

export function boundsOf(points: readonly Point[]): Box {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

export function isMarkTooSmall(points: readonly Point[], size: { width: number; height: number }): boolean {
  const b = boundsOf(points);
  return Math.max((b.x1 - b.x0) * size.width, (b.y1 - b.y0) * size.height) < MIN_MARK_PX;
}

// Lines and numbers grow with the page, so the screen at any scale and the picture look alike.
export const strokeWidth = (pageWidth: number): number => Math.max(2, pageWidth * 0.0035);
export const badgeRadius = (pageWidth: number): number => Math.max(9, pageWidth * 0.014);
const arrowHead = (pageWidth: number): number => Math.max(10, pageWidth * 0.022);
// The half-angle of the head of an arrow.
const HEAD_ANGLE = Math.PI / 7;

// Two decimals are finer than a point of a screen; the path stays short.
const n = (value: number): string => String(Math.round(value * 100) / 100);

// The outline of a mark as SVG path data, in points of a page `width` × `height`.
export function markPath(mark: Pick<Mark, 'tool' | 'points'>, width: number, height: number): string {
  const px = mark.points.map((p) => ({ x: p.x * width, y: p.y * height }));
  if (mark.tool === 'pen') return penPath(px);
  if (mark.tool === 'highlight') {
    const lines: string[] = [];
    for (let i = 0; i + 1 < px.length; i += 2) {
      const b = boundsOf([px[i]!, px[i + 1]!]);
      lines.push(`M ${n(b.x0)} ${n(b.y0)} H ${n(b.x1)} V ${n(b.y1)} H ${n(b.x0)} Z`);
    }
    return lines.join(' ');
  }
  const [from, to] = [px[0]!, px.at(-1)!];
  if (mark.tool === 'arrow') {
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    // A short arrow keeps its head inside it.
    const head = Math.min(arrowHead(width), length * 0.45);
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const wing = (side: number) => ({ x: to.x - head * Math.cos(angle + side * HEAD_ANGLE), y: to.y - head * Math.sin(angle + side * HEAD_ANGLE) });
    const [left, right] = [wing(1), wing(-1)];
    return `M ${n(from.x)} ${n(from.y)} L ${n(to.x)} ${n(to.y)} M ${n(left.x)} ${n(left.y)} L ${n(to.x)} ${n(to.y)} L ${n(right.x)} ${n(right.y)}`;
  }
  const b = boundsOf(px);
  if (mark.tool === 'rect') return `M ${n(b.x0)} ${n(b.y0)} H ${n(b.x1)} V ${n(b.y1)} H ${n(b.x0)} Z`;
  const [cx, cy, rx, ry] = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.x1 - b.x0) / 2, (b.y1 - b.y0) / 2];
  return `M ${n(cx - rx)} ${n(cy)} A ${n(rx)} ${n(ry)} 0 1 0 ${n(cx + rx)} ${n(cy)} A ${n(rx)} ${n(ry)} 0 1 0 ${n(cx - rx)} ${n(cy)} Z`;
}

// The line of the pen through the middles of its pieces: smooth without a library, the same on the screen and on the
// picture. A single point is a dot.
function penPath(px: readonly Point[]): string {
  const first = px[0]!;
  if (px.length === 1) return `M ${n(first.x)} ${n(first.y)} l 0.01 0`;
  const parts = [`M ${n(first.x)} ${n(first.y)}`];
  for (let i = 1; i < px.length - 1; i++) {
    const [p, next] = [px[i]!, px[i + 1]!];
    parts.push(`Q ${n(p.x)} ${n(p.y)} ${n((p.x + next.x) / 2)} ${n((p.y + next.y) / 2)}`);
  }
  const last = px.at(-1)!;
  parts.push(`L ${n(last.x)} ${n(last.y)}`);
  return parts.join(' ');
}

// Where the number of a mark stands: at the start of its shape — the tail of an arrow, the start of the first line of
// selected text, the top left of the others.
export function badgeAt(mark: Pick<Mark, 'tool' | 'points'>): Point {
  if (mark.tool === 'arrow') return mark.points[0]!;
  if (mark.tool === 'highlight') {
    const first = boundsOf(mark.points.slice(0, 2));
    return { x: first.x0, y: first.y0 };
  }
  const b = boundsOf(mark.points);
  return { x: b.x0, y: b.y0 };
}
