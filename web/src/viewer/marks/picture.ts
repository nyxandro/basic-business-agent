// The picture of the marks for the agent (spec, section 8.32, «Картинка для агента»; check V38): one JPEG a message —
// the provider of the main model takes at most 4 pictures a request and shrinks any to about 2 000 tokens, so six
// whole pages in one picture read wrong, and six bands round the marks read right. On each page with marks — a band
// from the highest mark to the lowest with room round it, the page's whole width (a page wider than a sheet of paper —
// the width of the marks with room); the bands top to bottom in page order under «Стр. N»; the sheet no wider than
// 1 200 and no higher than 2 600 points. A picture file — whole, fitted into the same.
import { MODEL_PICTURE_MAX_BYTES } from '@bba/contracts';
import { ru } from '../../i18n/ru.ts';
import { badgeAt, badgeRadius, boundsOf, clampShare, markPath, strokeWidth, type Box } from './geometry.ts';
import type { Mark } from './types.ts';

const SHEET_WIDTH = 1200;
const SHEET_HEIGHT = 2600;
// A page of PDF is drawn at most at 2 points a PDF point: A4 is 1190 × 1684, its letters are clear.
const MAX_SCALE = 2;
// Room above and below the marks of a page — a share of its height.
const BAND_ROOM = 0.08;
// A page wider than this (PDF points) is a sheet of Excel «whole» (spec, 8.27): its band is as wide as the marks.
const WIDE_PAGE = 900;
const SIDE_ROOM = 150;
const MIN_BAND_WIDTH = 600;
const LABEL_HEIGHT = 36;
const JPEG_QUALITY = 0.85;
// How strong the marker of selected text is — the same on the screen (marks.module.css).
export const HIGHLIGHT_ALPHA = 0.3;

// A page of the picture: its size (PDF points, or pixels of a picture file) and how its part is drawn.
export interface PicturePage {
  page: number;
  width: number;
  height: number;
  // Draws the part `region` of the page into `canvas`, `scale` points of the canvas a point of the page.
  draw: (canvas: HTMLCanvasElement, region: Box, scale: number) => Promise<void>;
}

// The part of a page the picture shows: round the marks on a page, the whole of a picture file.
export function bandOf(marks: readonly Mark[], size: { width: number; height: number }, paged: boolean): Box {
  if (!paged) return { x0: 0, y0: 0, x1: 1, y1: 1 };
  const b = boundsOf(marks.flatMap((m) => m.points));
  const y0 = clampShare(b.y0 - BAND_ROOM);
  const y1 = clampShare(b.y1 + BAND_ROOM);
  if (size.width <= WIDE_PAGE) return { x0: 0, y0, x1: 1, y1 };
  const room = SIDE_ROOM / size.width;
  const half = Math.max(b.x1 - b.x0 + 2 * room, MIN_BAND_WIDTH / size.width) / 2;
  const middle = (b.x0 + b.x1) / 2;
  // A band that would leave the page is moved back in, not cut.
  const x0 = clampShare(Math.min(middle - half, 1 - 2 * half));
  return { x0, y0, x1: clampShare(x0 + 2 * half), y1 };
}

export interface SheetPart {
  page: PicturePage;
  region: Box;
  // Points of the sheet a point of the page.
  scale: number;
  width: number;
  height: number;
  // Where the band stands on the sheet, under its label.
  top: number;
}

// Where every band stands on the sheet and at what scale; a sheet too high is made smaller whole.
export function sheetLayout(parts: readonly { page: PicturePage; region: Box }[], labels: boolean): { parts: SheetPart[]; width: number; height: number; label: number } {
  const sized = parts.map(({ page, region }) => {
    const w = (region.x1 - region.x0) * page.width;
    const h = (region.y1 - region.y0) * page.height;
    const scale = Math.min(labels ? MAX_SCALE : 1, SHEET_WIDTH / w, labels ? Infinity : SHEET_HEIGHT / h);
    return { page, region, scale, w, h };
  });
  const label = labels ? LABEL_HEIGHT : 0;
  const total = sized.reduce((sum, p) => sum + label + p.h * p.scale, 0);
  const shrink = Math.min(1, SHEET_HEIGHT / total);
  // Positions are summed exactly and cut down to whole points only each for itself: rounding does not add up.
  let top = 0;
  const placed = sized.map((p) => {
    const scale = p.scale * shrink;
    top += label * shrink;
    const part = { page: p.page, region: p.region, scale, width: Math.floor(p.w * scale), height: Math.floor(p.h * scale), top: Math.floor(top) };
    top += p.h * scale;
    return part;
  });
  return { parts: placed, width: Math.max(...placed.map((p) => p.width)), height: Math.round(top), label: label * shrink };
}

// The marks of one page over its band: the same outline, line and numbers as on the screen (geometry.ts).
function drawMarks(context: CanvasRenderingContext2D, part: SheetPart, marks: readonly { mark: Mark; number: number }[], color: string): void {
  const pageWidth = part.page.width * part.scale;
  const pageHeight = part.page.height * part.scale;
  context.save();
  context.translate(-part.region.x0 * pageWidth, -part.region.y0 * pageHeight);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = strokeWidth(pageWidth);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const { mark } of marks) {
    const path = new Path2D(markPath(mark, pageWidth, pageHeight));
    if (mark.tool !== 'highlight') {
      context.stroke(path);
      continue;
    }
    // Selected text — as with a marker: the colour over the letters, which stay readable.
    context.save();
    context.globalAlpha = HIGHLIGHT_ALPHA;
    context.globalCompositeOperation = 'multiply';
    context.fill(path);
    context.restore();
  }
  const radius = badgeRadius(pageWidth);
  context.font = `700 ${Math.round(radius * 1.15)}px system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (const { mark, number } of marks) {
    const at = badgeAt(mark);
    const [x, y] = [at.x * pageWidth, at.y * pageHeight];
    context.fillStyle = color;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#ffffff';
    context.fillText(String(number), x, y + 1);
  }
  context.restore();
}

function jpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob gave nothing'))), 'image/jpeg', JPEG_QUALITY);
  });
}

// `marks` — all the marks in their order: the number of a mark is its place in the list.
export async function marksPicture(pages: readonly PicturePage[], marks: readonly Mark[], paged: boolean): Promise<Blob> {
  const numbered = marks.map((mark, i) => ({ mark, number: i + 1 }));
  // The colour of the marks on the screen (tokens.css), the same in both themes.
  const color = getComputedStyle(document.documentElement).getPropertyValue('--mark').trim();
  if (!color) throw new Error('no --mark colour in the theme');
  const used = pages.filter((p) => numbered.some((m) => m.mark.page === p.page)).sort((a, b) => a.page - b.page);
  const layout = sheetLayout(
    used.map((page) => ({ page, region: bandOf(marks.filter((m) => m.page === page.page), page, paged) })),
    paged,
  );
  const sheet = document.createElement('canvas');
  sheet.width = layout.width;
  sheet.height = layout.height;
  const context = sheet.getContext('2d');
  if (!context) throw new Error('no 2d context for the picture of marks');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, sheet.width, sheet.height);
  for (const part of layout.parts) {
    if (layout.label > 0) {
      context.fillStyle = '#f2f2f8';
      context.fillRect(0, part.top - layout.label, sheet.width, layout.label);
      context.fillStyle = '#14142b';
      context.font = `600 ${Math.round(layout.label * 0.5)}px system-ui, sans-serif`;
      context.textAlign = 'left';
      context.textBaseline = 'middle';
      context.fillText(ru.marks.message.page(part.page.page), 12, part.top - layout.label / 2);
    }
    const band = document.createElement('canvas');
    band.width = part.width;
    band.height = part.height;
    await part.page.draw(band, part.region, part.scale);
    const bandContext = band.getContext('2d');
    if (!bandContext) throw new Error('no 2d context for a band of the picture of marks');
    drawMarks(bandContext, part, numbered.filter((m) => m.mark.page === part.page.page), color);
    context.drawImage(band, 0, part.top);
  }
  const blob = await jpeg(sheet);
  if (blob.size > MODEL_PICTURE_MAX_BYTES) throw new Error(`the picture of marks is ${blob.size} bytes`);
  return blob;
}
