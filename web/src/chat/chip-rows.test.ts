import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { chipMin, chipRows, chipWidths, rowsCost, stableRows, type ChipSize } from './chip-rows.ts';

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

  it('gives the chips of every row but the last the full width exactly, and the last row its names whole', () => {
    // The two chips of the stand of 17.11: 352 and 432 px in a row of 736 — the names give a little.
    const chips = sized([352, 432, 200, 150]);
    const widths = chipWidths(chips, [1, 3], 736, GAP);
    expect(widths[0]! + widths[1]! + GAP).toBe(736);
    expect(widths.slice(2)).toEqual([200, 150]);
    // A row with room is stretched to the width, each chip by its share.
    const roomy = chipWidths(sized([300, 200, 100]), [1, 2], 736, GAP);
    expect(roomy[0]! + roomy[1]! + GAP).toBe(736);
    expect(roomy[0]!).toBeGreaterThan(roomy[1]!);
  });

  it('keeps the rows above a file gone and packs the rest anew, as a paragraph reflows; files come join the last row', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const size = new Map<string, ChipSize>(ids.map((id) => [id, { natural: 300, min: 210 }]));
    const rows = [['a', 'b'], ['c', 'd'], ['e']];
    // «c» goes: the row above stays; «d» is no longer left alone — «e» comes up beside it (screenshot of 17.11).
    expect(stableRows(rows, ['a', 'b', 'd', 'e'], size, 736, GAP)).toEqual([['a', 'b'], ['d', 'e']]);
    // The only file of the last row goes: the row goes, the rest stay.
    expect(stableRows(rows, ['a', 'b', 'c', 'd'], size, 736, GAP)).toEqual([['a', 'b'], ['c', 'd']]);
    // «f» comes: the rows above the last stay, the last is laid out with it.
    size.set('f', { natural: 300, min: 210 });
    expect(stableRows(rows, [...ids, 'f'], size, 736, GAP)).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']]);
    // Nothing before: laid out whole.
    expect(stableRows(null, ids, size, 736, GAP).flat()).toEqual(ids);
    // An upload becomes its file: the file takes the upload's place, nothing else moves.
    size.set('up:1', { natural: 300, min: 210 });
    size.set('up:2', { natural: 300, min: 210 });
    size.set('p1', { natural: 280, min: 196 });
    expect(stableRows([['a', 'up:1'], ['up:2']], ['a', 'p1', 'up:2'], size, 736, GAP)).toEqual([['a', 'p1'], ['up:2']]);
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
        ends.forEach((end, r) => {
          const row = planned.slice(start, end + 1);
          const used = row.reduce((sum, w) => sum + w, 0) + GAP * (row.length - 1);
          // Every row but the last fills the width exactly; none is wider.
          if (r < ends.length - 1) expect(used).toBe(width);
          else expect(used).toBeLessThanOrEqual(width);
          row.forEach((w, k) => {
            if (row.length > 1) expect(w).toBeGreaterThanOrEqual(chips[start + k]!.min);
          });
          start = end + 1;
        });
      }),
      { examples: [[[320, 460, 340, 330, 310, 220, 380, 410, 390, 360, 370, 340], 736], [[], 736], [[900], 300]] },
    );
  });
});

describe('rows kept while files come and go', () => {
  it('keeps every row but the changed ones, in order, every file in one row', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 60, max: 700 }), { minLength: 1, maxLength: 20 }), fc.array(fc.boolean(), { maxLength: 20 }), fc.nat(5), (widths, gone, added) => {
        const ids = widths.map((_, i) => `f${i}`);
        const sizes = new Map(ids.map((id, i) => [id, { natural: widths[i]!, min: chipMin(widths[i]!) }] as const));
        const ends = chipRows(sized(widths), 736, GAP);
        const rows = ends.map((end, r) => ids.slice(r === 0 ? 0 : ends[r - 1]! + 1, end + 1));
        // Some files go: the rows above the first one touched stay as they were, the rest are packed anew.
        const left = ids.filter((_, i) => !gone[i]);
        const afterGoing = stableRows(rows, left, sizes, 736, GAP);
        expect(afterGoing.flat()).toEqual(left);
        const touched = rows.findIndex((row) => row.some((id) => !left.includes(id)));
        const above = touched < 0 ? rows : rows.slice(0, touched);
        expect(afterGoing.slice(0, above.length)).toEqual(above);
        const rest = left.slice(above.flat().length);
        const restEnds = chipRows(rest.map((id) => sizes.get(id)!), 736, GAP);
        expect(afterGoing.slice(above.length)).toEqual(restEnds.map((end, r) => rest.slice(r === 0 ? 0 : restEnds[r - 1]! + 1, end + 1)));
        // …and some come: the rows above the last stay.
        const fresh = Array.from({ length: added }, (_, i) => `n${i}`);
        fresh.forEach((id) => sizes.set(id, { natural: 250, min: chipMin(250) }));
        const afterComing = stableRows(afterGoing, [...left, ...fresh], sizes, 736, GAP);
        expect(afterComing.flat()).toEqual([...left, ...fresh]);
        if (fresh.length > 0) expect(afterComing.slice(0, Math.max(0, afterGoing.length - 1))).toEqual(afterGoing.slice(0, -1));
      }),
    );
  });
});
