// Where the bands of the picture of marks lie (spec, section 8.32, «Картинка для агента»; check V38): round the marks
// with room, the page's width or, on a wide sheet, the marks' width; the sheet no wider than 1 200 and no higher than
// 2 600 points. The drawing itself needs a real canvas: it is checked in the browser.
import { describe, expect, it } from 'vitest';
import { bandOf, sheetLayout, type PicturePage } from './picture.ts';
import type { Mark } from './types.ts';

const A4 = { width: 595, height: 842 };
const SHEET = { width: 3000, height: 14000 };
const rect = (page: number, x0: number, y0: number, x1: number, y1: number): Mark => ({ id: `${page}-${x0}-${y0}`, page, tool: 'rect', points: [{ x: x0, y: y0 }, { x: x1, y: y1 }], comment: '' });
const pageOf = (page: number, size: { width: number; height: number }): PicturePage => ({ page, ...size, draw: () => Promise.resolve() });

describe('the band of a page', () => {
  it('runs the page’s whole width, from the highest mark to the lowest with room, inside the page', () => {
    const band = bandOf([rect(1, 0.2, 0.3, 0.4, 0.32), rect(1, 0.6, 0.35, 0.7, 0.36)], A4, true);
    expect(band.x0).toBe(0);
    expect(band.x1).toBe(1);
    expect(band.y0).toBeCloseTo(0.22);
    expect(band.y1).toBeCloseTo(0.44);
    expect(bandOf([rect(1, 0.2, 0.01, 0.4, 0.02)], A4, true).y0).toBe(0);
  });

  it('on a wide sheet is as wide as the marks with room, no narrower than 600 points, moved back inside the page', () => {
    const band = bandOf([rect(1, 0.5, 0.5, 0.52, 0.51)], SHEET, true);
    expect(band.x0).toBeCloseTo(0.41);
    expect(band.x1).toBeCloseTo(0.61);
    const edge = bandOf([rect(1, 0.95, 0.5, 0.99, 0.51)], SHEET, true);
    expect(edge.x0).toBeCloseTo(0.8);
    expect(edge.x1).toBeCloseTo(1);
  });

  it('a picture file is shown whole', () => {
    expect(bandOf([rect(1, 0.5, 0.5, 0.6, 0.6)], { width: 4000, height: 3000 }, false)).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
  });
});

describe('the sheet', () => {
  it('stacks the bands under their labels at 2 points a PDF point', () => {
    const band = { x0: 0, y0: 0.22, x1: 1, y1: 0.4 };
    const layout = sheetLayout([{ page: pageOf(1, A4), region: band }, { page: pageOf(3, A4), region: band }], true);
    expect(layout.width).toBe(1190);
    expect(layout.parts.map((p) => [p.top, p.height])).toEqual([
      [36, 303],
      [375, 303],
    ]);
    expect(layout.height).toBe(678);
  });

  it('a sheet too high is made smaller whole, never over 1 200 × 2 600', () => {
    const whole = { x0: 0, y0: 0, x1: 1, y1: 1 };
    const layout = sheetLayout(Array.from({ length: 10 }, (_, i) => ({ page: pageOf(i + 1, A4), region: whole })), true);
    expect(layout.height).toBeLessThanOrEqual(2600);
    expect(layout.width).toBeLessThanOrEqual(1200);
    expect(layout.parts.at(-1)!.top + layout.parts.at(-1)!.height).toBeLessThanOrEqual(2600);
  });

  it('a big picture file is fitted into 1 200 × 2 600, a small one stays as it is', () => {
    const big = sheetLayout([{ page: pageOf(1, { width: 4000, height: 3000 }), region: { x0: 0, y0: 0, x1: 1, y1: 1 } }], false);
    expect([big.width, big.height]).toEqual([1200, 900]);
    const small = sheetLayout([{ page: pageOf(1, { width: 640, height: 480 }), region: { x0: 0, y0: 0, x1: 1, y1: 1 } }], false);
    expect([small.width, small.height]).toEqual([640, 480]);
  });
});
