// The square the browser cuts from the chosen picture (spec, section 8.17): from the middle, by the
// short side, scaled down to at most 256 px and never up.
import { AGENT_IMAGE_SIDE_PX } from '@bba/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { squareCrop } from './agent-image.ts';

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
