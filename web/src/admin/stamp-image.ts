// The stamp, the signature and the logo are prepared in the browser before they leave
// (docs/specs/[20.11.2026]-org-letterhead.md): scaled down (never up), the white of the paper made transparent when asked
// — a stamp over the signature line must not lie as a white square — the empty margins cut, saved as PNG. A scan from a
// phone of several megabytes becomes tens of kilobytes. The server checks the bytes again.
import { ORG_IMAGE_SOURCE_MAX_BYTES, ORG_LOGO_MAX_SIDE_PX, ORG_STAMP_WIDTH_PX } from '@bba/contracts';

export type OrgPictureKind = 'logo' | 'stamp' | 'signature';

// Paper lighter than this goes transparent; ink darker than INK stays whole; between — a soft edge.
const PAPER = 235;
const INK = 185;
// A point this transparent is margin when the margins are cut.
const VISIBLE_ALPHA = 16;
// Around the cut picture, so the strokes do not touch its edge.
const PAD = 8;

// The size to draw at: the stamp and the signature at most ORG_STAMP_WIDTH_PX wide and high, the logo at most
// ORG_LOGO_MAX_SIDE_PX on its longer side.
export function targetSize(kind: OrgPictureKind, width: number, height: number): { width: number; height: number } {
  const max = kind === 'logo' ? ORG_LOGO_MAX_SIDE_PX : ORG_STAMP_WIDTH_PX;
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// White to transparent, in place: the brightness of a point decides its transparency, its colour stays.
export function paperToTransparent(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const light = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    const keep = light >= PAPER ? 0 : light <= INK ? 1 : (PAPER - light) / (PAPER - INK);
    data[i + 3] = Math.round(data[i + 3]! * keep);
  }
}

// The box of the visible points with a small margin; null — nothing is visible (an empty or white picture).
export function visibleBox(data: Uint8ClampedArray, width: number, height: number): { x: number; y: number; width: number; height: number } | null {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! <= VISIBLE_ALPHA) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return null;
  const x = Math.max(0, left - PAD);
  const y = Math.max(0, top - PAD);
  return { x, y, width: Math.min(width, right + PAD + 1) - x, height: Math.min(height, bottom + PAD + 1) - y };
}

// Why a chosen file did not become a picture: too big to open, not a picture the browser reads, nothing left of it
// after the white went, or the browser could not draw it.
export type OrgImageFailure = 'too-big' | 'unreadable' | 'empty' | 'not-prepared';

export class OrgImageError extends Error {
  readonly reason: OrgImageFailure;

  constructor(reason: OrgImageFailure, options?: { cause?: unknown }) {
    super(`org image is ${reason}`, options);
    this.name = 'OrgImageError';
    this.reason = reason;
  }
}

function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2d canvas is not available');
  return { canvas, context };
}

async function pngOf(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('canvas.toBlob gave no picture');
  return blob;
}

export async function prepareOrgImage(file: File, kind: OrgPictureKind, removeWhite: boolean): Promise<Blob> {
  if (file.size > ORG_IMAGE_SOURCE_MAX_BYTES) throw new OrgImageError('too-big');
  let bitmap: ImageBitmap;
  try {
    // A phone writes its rotation into EXIF; the picture must stand as the person saw it.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (error) {
    throw new OrgImageError('unreadable', { cause: error });
  }
  try {
    const size = targetSize(kind, bitmap.width, bitmap.height);
    const drawn = canvasOf(size.width, size.height);
    drawn.context.imageSmoothingQuality = 'high';
    drawn.context.drawImage(bitmap, 0, 0, size.width, size.height);
    if (!removeWhite) return await pngOf(drawn.canvas);
    const pixels = drawn.context.getImageData(0, 0, size.width, size.height);
    paperToTransparent(pixels.data);
    const box = visibleBox(pixels.data, size.width, size.height);
    if (!box) throw new OrgImageError('empty');
    drawn.context.putImageData(pixels, 0, 0);
    const cut = canvasOf(box.width, box.height);
    cut.context.drawImage(drawn.canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
    return await pngOf(cut.canvas);
  } catch (error) {
    if (error instanceof OrgImageError) throw error;
    throw new OrgImageError('not-prepared', { cause: error });
  } finally {
    bitmap.close();
  }
}
