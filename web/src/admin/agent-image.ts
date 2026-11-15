// The agent's picture is prepared in the browser before it leaves (spec, section 8.17): a square cut
// from the middle by the short side, scaled down to AGENT_IMAGE_SIDE_PX (never up) and saved as
// WebP. Any photo from a phone fits, and employees get tens of kilobytes instead of megabytes. A
// browser that cannot write WebP writes PNG (the rule of canvas.toBlob); the server takes both.
import { AGENT_IMAGE_SIDE_PX, AGENT_IMAGE_SOURCE_MAX_BYTES } from '@bba/contracts';

const WEBP_QUALITY = 0.9;

export interface Crop {
  sx: number;
  sy: number;
  side: number;
  target: number;
}

export function squareCrop(width: number, height: number): Crop {
  const side = Math.min(width, height);
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side, target: Math.min(side, AGENT_IMAGE_SIDE_PX) };
}

// Why a chosen file did not become a picture: too big to open; not an image the browser reads
// (damaged, HEIC in a browser without it, a document); or an opened picture the browser could not
// draw and write (no 2D canvas, no memory left for it) — the file is fine, the browser is not.
export type AgentImageFailure = 'too-big' | 'unreadable' | 'not-prepared';

export class AgentImageError extends Error {
  readonly reason: AgentImageFailure;

  constructor(reason: AgentImageFailure, options?: { cause?: unknown }) {
    super(`agent image is ${reason}`, options);
    this.name = 'AgentImageError';
    this.reason = reason;
  }
}

export async function prepareAgentImage(file: File): Promise<Blob> {
  if (file.size > AGENT_IMAGE_SOURCE_MAX_BYTES) throw new AgentImageError('too-big');
  let bitmap: ImageBitmap;
  try {
    // A phone writes its rotation into EXIF; the picture must stand as the person saw it.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (error) {
    throw new AgentImageError('unreadable', { cause: error });
  }
  try {
    return await drawSquare(bitmap);
  } catch (error) {
    throw new AgentImageError('not-prepared', { cause: error });
  } finally {
    bitmap.close();
  }
}

async function drawSquare(bitmap: ImageBitmap): Promise<Blob> {
  const crop = squareCrop(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = crop.target;
  canvas.height = crop.target;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2d canvas is not available');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, crop.sx, crop.sy, crop.side, crop.side, 0, 0, crop.target, crop.target);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', WEBP_QUALITY));
  if (!blob) throw new Error('canvas.toBlob gave no picture');
  return blob;
}
