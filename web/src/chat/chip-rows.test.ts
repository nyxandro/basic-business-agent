import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { chipMin, chipRows, chipWidths, rowsCost, type ChipSize } from './chip-rows.ts';

const GAP = 6;
const sized = (widths: number[]): ChipSize[] => widths.map((natural) => ({ natural, min: chipMin(natural) }));
// In order: a chip goes on the row while it fits as it is — how the chips lay before (screenshot of 17.11).
function greedy(chips: ChipSize[], width: number): number[] {
  const ends: number[] = [];
  let used = 0;
  chips.forEach((chip, i) => {
    if (i > 0 && used + GAP + chip.natural > width) {
      ends.push(i - 1);
      used = chip.natural;
    } else used += (i > 0 && used > 0 ? GAP : 0) + chip.natural;
  });
  if (chips.length > 0) ends.push(chips.length - 1);
  return ends;
}
const rowsOf = (ends: number[]) => ends.map((end, i) => end - (i === 0 ? -1 : ends[i - 1]!));

describe('rows of the attached files (decision of the owner 17.11)', () => {
  it('packs the twelve files of the screenshot into fewer, fuller rows, in their order', () => {
    // The widths of the chips of the screenshot, the row of the composer 736 px.
    const chips = sized([320, 460, 340, 330, 310, 220, 380, 410, 390, 360, 370, 340]);
    expect(rowsOf(greedy(chips, 736))).toHaveLength(9);
    const ends = chipRows(chips, 736, GAP);
    expect(rowsOf(ends).length).toBeLessThanOrEqual(6);
    expect(rowsCost(chips, ends, 736, GAP)).toBeLessThan(rowsCost(chips, greedy(chips, 736), 736, GAP));
  });

  it('narrows the chips of a row that needs its names cut so the row fits exactly — the browser breaks by them', () => {
    // The two chips of the stand of 17.11: 352 and 432 px in a row of 736.
    const chips = sized([352, 432]);
    expect(chipRows(chips, 736, GAP)).toEqual([1]);
    const widths = chipWidths(chips, [1], 736, GAP);
    expect(widths[0]! + widths[1]! + GAP).toBeLessThanOrEqual(736);
    expect(widths[0]! + widths[1]! + GAP).toBeGreaterThanOrEqual(734);
  });

  it('keeps chips that fit on one row on it, and a chip wider than the row on its own', () => {
    expect(chipRows(sized([120, 150, 200]), 736, GAP)).toEqual([2]);
    expect(chipRows(sized([900, 120]), 736, GAP)).toEqual([0, 1]);
    expect(chipRows([], 736, GAP)).toEqual([]);
  });

  it('never shrinks a chip by more than 30 %, nor below the narrowest chip', () => {
    expect(chipMin(600)).toBe(420);
    expect(chipMin(150)).toBe(140);
    expect(chipMin(90)).toBe(90);
  });

  it('gives every file one row in order, fits each row, and lays them no worse than one after another', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 60, max: 900 }), { maxLength: 30 }), fc.integer({ min: 240, max: 1200 }), (widths, width) => {
        const chips = sized(widths);
        const ends = chipRows(chips, width, GAP);
        // Every chip in exactly one row, in order.
        expect(ends.length === 0 ? chips.length === 0 : ends.at(-1) === chips.length - 1).toBe(true);
        ends.forEach((end, i) => expect(end).toBeGreaterThan(i === 0 ? -1 : ends[i - 1]!));
        // A row of several chips fits with the names shrunk at most to their least.
        let start = 0;
        for (const end of ends) {
          const row = chips.slice(start, end + 1);
          if (row.length > 1) expect(row.reduce((sum, c) => sum + c.min, 0) + GAP * (row.length - 1)).toBeLessThanOrEqual(width);
          start = end + 1;
        }
        expect(rowsCost(chips, ends, width, GAP)).toBeLessThanOrEqual(rowsCost(chips, greedy(chips, width), width, GAP) + 1e-9);
        // The widths the rows start from fit each row, so the browser breaks the rows where they were chosen.
        const planned = chipWidths(chips, ends, width, GAP);
        start = 0;
        for (const end of ends) {
          const row = planned.slice(start, end + 1);
          expect(row.reduce((sum, w) => sum + w, 0) + GAP * (row.length - 1)).toBeLessThanOrEqual(width);
          row.forEach((w, k) => {
            const chip = chips[start + k]!;
            expect(w).toBeLessThanOrEqual(chip.natural);
            if (row.length > 1) expect(w).toBeGreaterThanOrEqual(chip.min);
          });
          start = end + 1;
        }
      }),
      { examples: [[[320, 460, 340, 330, 310, 220, 380, 410, 390, 360, 370, 340], 736], [[], 736], [[900], 300]] },
    );
  });
});
