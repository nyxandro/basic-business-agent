// How the attached files lie in rows above the input (decision of the owner 17.11: no half-empty rows).
// The order stays — chips would jump at every new file otherwise; the rows are chosen as a line of text
// is broken in a book: of all ways to break the chips into rows, the one where the rows are fullest,
// letting a long name give up to 30 % of its chip (cut in the middle, its end kept). Every row but the
// last is then stretched to the full width (Attachments.tsx), the last keeps its chips as they are.

export interface ChipSize {
  // The chip with its whole name.
  natural: number;
  // The narrowest it may be: its name cut in the middle.
  min: number;
}

// A chip gives at most this share of its width, and never becomes narrower than MIN_CHIP_PX.
const MIN_SHARE = 0.7;
const MIN_CHIP_PX = 140;
// A name cut costs more than the same room left empty: rows are filled by cutting only when it pays.
const SHRINK_WEIGHT = 4;
// Of two equal ways, fewer rows.
const ROW_COST = 0.01;

export const chipMin = (natural: number) => Math.min(natural, Math.max(MIN_CHIP_PX, Math.round(natural * MIN_SHARE)));

// What a row of chips from..to costs; Infinity when its chips do not fit even with the names cut.
function rowCost(chips: readonly ChipSize[], from: number, to: number, width: number, gap: number, last: boolean): number {
  let natural = 0;
  let least = 0;
  for (let i = from; i <= to; i++) {
    natural += chips[i]!.natural;
    least += chips[i]!.min;
  }
  const gaps = gap * (to - from);
  // One chip always has its row: wider than it, it is cut to the row.
  if (to > from && least + gaps > width) return Infinity;
  const room = width - natural - gaps;
  if (room < 0) return ROW_COST + SHRINK_WEIGHT * (room / width) ** 2;
  // The last row is not stretched: its room is not empty space between chips.
  return ROW_COST + (last ? 0 : (room / width) ** 2);
}

// The index of the last chip of each row, in order.
export function chipRows(chips: readonly ChipSize[], width: number, gap: number): number[] {
  const n = chips.length;
  // best[i]: the least cost of laying chips i.. ; next[i]: where the first of those rows ends.
  const best = new Array<number>(n + 1).fill(Infinity);
  const next = new Array<number>(n).fill(n - 1);
  best[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i; j < n; j++) {
      const row = rowCost(chips, i, j, width, gap, j === n - 1);
      if (row === Infinity) break;
      if (row + best[j + 1]! < best[i]!) {
        best[i] = row + best[j + 1]!;
        next[i] = j;
      }
    }
  }
  const ends: number[] = [];
  for (let i = 0; i < n; i = next[i]! + 1) ends.push(next[i]!);
  return ends;
}

// The width each chip starts from in its row. The browser breaks rows by these, so a row whose names are
// cut gets its chips narrowed beforehand — each by its share of what it may give — to fit the row
// exactly; a row with room keeps the whole names and is stretched by the browser.
export function chipWidths(chips: readonly ChipSize[], ends: readonly number[], width: number, gap: number): number[] {
  const widths: number[] = [];
  let from = 0;
  for (const end of ends) {
    const row = chips.slice(from, end + 1);
    const room = width - gap * (row.length - 1);
    const natural = row.reduce((sum, c) => sum + c.natural, 0);
    const give = row.reduce((sum, c) => sum + (c.natural - c.min), 0);
    const over = natural - room;
    for (const chip of row) {
      if (row.length === 1) widths.push(Math.min(chip.natural, width));
      else if (over <= 0 || give === 0) widths.push(chip.natural);
      // Whole pixels down: the row never comes out a pixel wider than the box.
      else widths.push(Math.max(chip.min, Math.floor(chip.natural - (over * (chip.natural - chip.min)) / give)));
    }
    from = end + 1;
  }
  return widths;
}

// The cost of a way to lay the chips: what chipRows makes least (for tests and comparisons).
export function rowsCost(chips: readonly ChipSize[], ends: readonly number[], width: number, gap: number): number {
  let total = 0;
  let from = 0;
  ends.forEach((end, i) => {
    total += rowCost(chips, from, end, width, gap, i === ends.length - 1);
    from = end + 1;
  });
  return total;
}
