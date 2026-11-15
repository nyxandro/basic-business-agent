// The square the browser cuts from the chosen picture (spec, section 8.17): from the middle, by the
// short side, scaled down to at most 256 px and never up. A file the browser cannot open and a
// browser that cannot draw the picture are told apart: the person does different things about them.
import { AGENT_IMAGE_SIDE_PX } from '@bba/contracts';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareAgentImage, squareCrop } from './agent-image.ts';

describe('squareCrop', () => {
  it('cuts the largest square from the middle, inside the picture, and never scales up', () => {
    const side = fc.integer({ min: 1, max: 12_000 });
    fc.assert(
      fc.property(side, side, (width, height) => {
        const crop = squareCrop(width, height);
        const short = Math.min(width, height);
        expect(crop.side).toBe(short);
        for (const [start, length] of [[crop.sx, width], [crop.sy, height]] as const) {
          expect(Number.isInteger(start) && start >= 0 && start + crop.side <= length).toBe(true);
          // As much is left on one side as on the other, to a pixel.
          expect(Math.abs(length - crop.side - start - start)).toBeLessThanOrEqual(1);
        }
        expect(crop.target).toBe(Math.min(short, AGENT_IMAGE_SIDE_PX));
      }),
      { examples: [[1, 1], [4032, 3024], [AGENT_IMAGE_SIDE_PX, AGENT_IMAGE_SIDE_PX], [300, 10], [10, 300], [257, 256]] },
    );
  });
});

describe('prepareAgentImage', () => {
  const photo = new File(['photo'], 'photo.png', { type: 'image/png' });
  const opened = () => ({ width: 1200, height: 800, close: vi.fn() });

  afterEach(() => vi.restoreAllMocks());

  it('calls a file the browser cannot open unreadable', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new DOMException('The source image could not be decoded.', 'InvalidStateError'))));
    await expect(prepareAgentImage(photo)).rejects.toMatchObject({ name: 'AgentImageError', reason: 'unreadable' });
  });

  it('calls an opened picture the browser could not draw not prepared, and lets the picture go', async () => {
    const bitmap = opened();
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve(bitmap)));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    await expect(prepareAgentImage(photo)).rejects.toMatchObject({ name: 'AgentImageError', reason: 'not-prepared' });
    expect(bitmap.close).toHaveBeenCalled();
  });

  it('calls a picture the canvas could not write not prepared', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve(opened())));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: vi.fn() }) as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(null));
    await expect(prepareAgentImage(photo)).rejects.toMatchObject({ name: 'AgentImageError', reason: 'not-prepared' });
  });
});
