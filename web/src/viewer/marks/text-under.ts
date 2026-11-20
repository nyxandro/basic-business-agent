// The text under a mark (spec, section 8.32), from the text PDF.js reads of the page: the agent finds the place in
// the original file by these words, not by the picture. A scan and a picture have no text — then nothing.
import { boundsOf, type Box } from './geometry.ts';
import type { Mark } from './types.ts';

export interface TextBox extends Box {
  text: string;
}

// The longest quote under a mark in the message; the whole text the model gets with the document (spec, 8.29).
export const QUOTE_MAX = 300;
// A line of the pen lower than this (a share of the height of the page) is an underline or a crossing-out, not a loop:
// it takes the text up to a line over it and a little under it. A loop takes what it goes round.
const PEN_THIN = 0.012;
const PEN_ABOVE = 0.015;
const PEN_BELOW = 0.003;
// An arrow points at text this far off its tip (shares of the width of the page)…
const ARROW_REACH = 0.04;
// …looked for a little beyond the tip, the way it points: a tip stopping between two lines points into one of them.
const ARROW_AHEAD = 0.01;
// A piece of text is under a frame when the frame covers at least this part of its height.
const COVERED_HEIGHT = 0.5;
// Pieces of a line further apart than this part of its height are separate words.
const WORD_GAP = 0.15;

// The part of a text item of PDF.js we read; marked content (no `str`) is skipped.
interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}
interface PdfViewport {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}

// The boxes of the pieces of text of a page as shares of the page as it is shown (turned, if the page is turned).
export function textBoxes(items: readonly unknown[], viewport: PdfViewport): TextBox[] {
  const boxes: TextBox[] = [];
  for (const raw of items) {
    const item = raw as Partial<PdfTextItem>;
    if (typeof item.str !== 'string' || !item.str.trim() || !item.transform) continue;
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = item.transform;
    const angle = Math.atan2(b, a);
    const width = item.width ?? 0;
    const height = item.height || Math.hypot(c, d);
    const along = { x: width * Math.cos(angle), y: width * Math.sin(angle) };
    const up = { x: -height * Math.sin(angle), y: height * Math.cos(angle) };
    const corners = [
      [e, f],
      [e + along.x, f + along.y],
      [e + up.x, f + up.y],
      [e + along.x + up.x, f + along.y + up.y],
    ].map(([x, y]) => viewport.convertToViewportPoint(x!, y!));
    const xs = corners.map((p) => p[0]! / viewport.width);
    const ys = corners.map((p) => p[1]! / viewport.height);
    boxes.push({ text: item.str, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
  }
  return boxes;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);

// The words of a piece the region covers in part — by its share of the width, widened to whole words.
function cut(box: TextBox, region: Box): string {
  const { text } = box;
  const span = box.x1 - box.x0;
  if (span <= 0 || (region.x0 <= box.x0 && region.x1 >= box.x1)) return text.trim();
  let from = Math.floor(((Math.max(region.x0, box.x0) - box.x0) / span) * text.length);
  let to = Math.ceil(((Math.min(region.x1, box.x1) - box.x0) / span) * text.length);
  const inWord = (i: number) => i > 0 && i < text.length && /\S/.test(text[i - 1]!) && /\S/.test(text[i]!);
  while (inWord(from)) from--;
  while (inWord(to)) to++;
  return text.slice(from, to).trim();
}

// Pieces in reading order: lines from the top down, each from the left; `aspect` — height of the page over its width.
function join(pieces: readonly TextBox[], aspect: number): string {
  const lines: TextBox[][] = [];
  for (const piece of [...pieces].sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1))) {
    const middle = (piece.y0 + piece.y1) / 2;
    const line = lines.find((l) => middle >= l[0]!.y0 && middle <= l[0]!.y1);
    if (line) line.push(piece);
    else lines.push([piece]);
  }
  const text = lines
    .map((line) =>
      line
        .sort((a, b) => a.x0 - b.x0)
        .reduce((out, piece, i) => {
          if (i === 0) return piece.text;
          const before = line[i - 1]!;
          const apart = piece.x0 - before.x1 > WORD_GAP * (before.y1 - before.y0) * aspect;
          return out + (apart ? ' ' : '') + piece.text;
        }, ''),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX).trimEnd()}…` : text;
}

// The distance from a point to a box, in shares of the width of the page.
function distance(point: { x: number; y: number }, box: Box, aspect: number): number {
  const dx = Math.max(box.x0 - point.x, 0, point.x - box.x1);
  const dy = Math.max(box.y0 - point.y, 0, point.y - box.y1) * aspect;
  return Math.hypot(dx, dy);
}

export function textUnder(mark: Pick<Mark, 'tool' | 'points'>, boxes: readonly TextBox[], aspect: number): string {
  if (mark.tool === 'arrow') {
    const [tail, tip] = [mark.points[0]!, mark.points.at(-1)!];
    // The way the arrow points, in shares of the width of the page.
    const way = { x: tip.x - tail.x, y: (tip.y - tail.y) * aspect };
    const length = Math.hypot(way.x, way.y) || 1;
    const ahead = { x: tip.x + (way.x / length) * ARROW_AHEAD, y: tip.y + (way.y / length) * (ARROW_AHEAD / aspect) };
    const near = boxes.map((box) => ({ box, d: distance(ahead, box, aspect) })).filter((b) => b.d <= ARROW_REACH);
    if (near.length === 0) return '';
    const { box } = near.reduce((best, b) => (b.d < best.d ? b : best));
    const line = boxes.filter((b) => (b.y0 + b.y1) / 2 >= box.y0 && (b.y0 + b.y1) / 2 <= box.y1);
    return join(line, aspect);
  }
  const b = boundsOf(mark.points);
  const line = mark.tool === 'pen' && b.y1 - b.y0 < PEN_THIN;
  const region = line ? { ...b, y0: b.y0 - PEN_ABOVE, y1: b.y1 + PEN_BELOW } : b;
  const pieces = boxes
    .filter((box) => overlap(region.y0, region.y1, box.y0, box.y1) >= COVERED_HEIGHT * (box.y1 - box.y0) && overlap(region.x0, region.x1, box.x0, box.x1) > 0)
    .map((box) => ({ ...box, text: cut(box, region) }))
    .filter((piece) => piece.text);
  return join(pieces, aspect);
}
