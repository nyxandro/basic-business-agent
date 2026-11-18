import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { clampZoom, FIT_MAX, fitScale, percent, ZOOM_MAX, ZOOM_MIN, ZOOM_STEPS, zoomIn, zoomOut } from './zoom.ts';

describe('the scale of the viewer (spec, section 8.27)', () => {
  it('goes by steps and stops at the limits', () => {
    expect(zoomIn(1)).toBe(1.1);
    expect(zoomOut(1)).toBe(0.9);
    // From a scale between the steps (fitted, or set by the fingers) to the nearest step that way.
    expect(zoomIn(0.49)).toBe(0.5);
    expect(zoomOut(0.49)).toBe(0.33);
    expect(zoomIn(ZOOM_MAX)).toBe(ZOOM_MAX);
    expect(zoomOut(ZOOM_MIN)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(percent(0.494)).toBe('49 %');
  });

  it('fits the page to the width, no bigger than 150 % on a wide screen', () => {
    // An A4 page (595 pt ≈ 794 px at 100 %) on a phone 390 px wide.
    expect(fitScale(390, 794)).toBeCloseTo(0.491, 3);
    expect(fitScale(1900, 794)).toBe(FIT_MAX);
  });

  it('«−» after «+» comes back to the step it left, inside the limits', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ZOOM_STEPS.slice(0, -1)), (step) => {
        expect(zoomOut(zoomIn(step))).toBe(step);
      }),
    );
    fc.assert(
      fc.property(fc.double({ min: 0, max: 10, noNaN: true }), (scale) => {
        for (const next of [zoomIn(scale), zoomOut(scale), clampZoom(scale)]) {
          expect(next).toBeGreaterThanOrEqual(ZOOM_MIN);
          expect(next).toBeLessThanOrEqual(ZOOM_MAX);
        }
      }),
    );
  });
});
