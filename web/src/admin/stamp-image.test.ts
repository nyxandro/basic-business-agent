// How the browser prepares the stamp, the signature and the logo (docs/specs/[20.11.2026]-org-letterhead.md): a scan of a
// phone becomes at most 600 points wide, the paper transparent, the margins cut. The drawing itself needs a real canvas;
// what it does to the points is checked here.
import { describe, expect, it } from 'vitest';
import { paperToTransparent, targetSize, visibleBox } from './stamp-image.ts';

// A scan: white paper with a blue round stamp in the middle and grey noise of the paper.
function scan(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  const r = Math.min(width, height) / 4;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const ink = Math.hypot(x - width / 2, y - height / 2) < r;
      const [red, green, blue] = ink ? [30, 60, 170] : [248, 247, 244];
      data.set([red, green, blue, 255], i);
    }
  }
  return data;
}

describe('the picture of the stamp', () => {
  it('takes a scan of a phone down to 600 points, never up, the logo to 1200', () => {
    expect(targetSize('stamp', 4032, 3024)).toEqual({ width: 600, height: 450 });
    expect(targetSize('signature', 1200, 3000)).toEqual({ width: 240, height: 600 });
    expect(targetSize('stamp', 300, 300)).toEqual({ width: 300, height: 300 });
    expect(targetSize('logo', 2400, 800)).toEqual({ width: 1200, height: 400 });
  });

  it('makes the paper transparent and keeps the ink whole, with a soft edge between', () => {
    const points = new Uint8ClampedArray([250, 250, 250, 255, 30, 60, 170, 255, 210, 210, 210, 255]);
    paperToTransparent(points);
    expect(points[3]).toBe(0);
    expect(points[7]).toBe(255);
    expect(points[11]).toBeGreaterThan(0);
    expect(points[11]).toBeLessThan(255);
    // The colour of the ink stays.
    expect([...points.slice(4, 7)]).toEqual([30, 60, 170]);
  });

  it('cuts the empty margins of a scan around the stamp, and finds nothing on white paper', () => {
    const { width, height } = targetSize('stamp', 4032, 3024);
    const data = scan(width, height);
    paperToTransparent(data);
    const box = visibleBox(data, width, height)!;
    // The stamp is a quarter of the short side in radius: the box is its circle and a few points around.
    expect(box.width).toBeGreaterThan(225);
    expect(box.width).toBeLessThan(250);
    expect(box.height).toBe(box.width);
    expect(box.x).toBeGreaterThan(170);
    const white = new Uint8ClampedArray(10 * 10 * 4).fill(255);
    paperToTransparent(white);
    expect(visibleBox(white, 10, 10)).toBeNull();
  });
});
