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

// The width of each chip. A row whose names must give is narrowed — each chip by its share of what it
// may give; every row but the last is then stretched to the full width exactly, each chip by its share;
// the last row keeps its chips as they are. Whole pixels: no row is a pixel wider than the box.
export function chipWidths(chips: readonly ChipSize[], ends: readonly number[], width: number, gap: number): number[] {
  const widths: number[] = [];
  let from = 0;
  ends.forEach((end, r) => {
    const row = chips.slice(from, end + 1);
    const room = width - gap * (row.length - 1);
    const natural = row.reduce((sum, c) => sum + c.natural, 0);
    const give = row.reduce((sum, c) => sum + (c.natural - c.min), 0);
    const over = natural - room;
    const planned = row.map((chip) => {
      if (row.length === 1) return Math.min(chip.natural, width);
      if (over <= 0 || give === 0) return chip.natural;
      return Math.max(chip.min, Math.floor(chip.natural - (over * (chip.natural - chip.min)) / give));
    });
    if (r < ends.length - 1) {
      const total = planned.reduce((sum, w) => sum + w, 0);
      const extra = room - total;
      const grown = planned.map((w) => w + Math.floor((extra * w) / total));
      // The pixels the rounding left go to the last chips of the row.
      for (let left = room - grown.reduce((sum, w) => sum + w, 0), k = grown.length - 1; left > 0; left--, k = (k - 1 + grown.length) % grown.length) grown[k]! += 1;
      widths.push(...grown);
    } else widths.push(...planned);
    from = end + 1;
  });
  return widths;
}

// The rows of the files as they change (the files by their ids, in order), as a paragraph reflows when a
// word goes: the rows above the first row touched — a file gone, or an upload become its file — stay
// where they are, and from that row on the files are packed anew, so no chip is left alone in a row
// another could share (the owner, 17.11). Files come at the end are laid out with the last row only.
// With nothing before (or another width) — anew.
export function stableRows(before: readonly (readonly string[])[] | null, ids: readonly string[], sizes: ReadonlyMap<string, ChipSize>, width: number, gap: number): string[][] {
  const sizeOf = (id: string) => {
    const size = sizes.get(id);
    if (!size) throw new Error(`chip ${id} was not measured`);
    return size;
  };
  const anew = (list: readonly string[]) => {
    const ends = chipRows(list.map(sizeOf), width, gap);
    return ends.map((end, r) => list.slice(r === 0 ? 0 : ends[r - 1]! + 1, end + 1));
  };
  if (!before) return anew(ids);
  const present = new Set(ids);
  const gone = before.findIndex((row) => row.some((id) => !present.has(id)));
  const flatBefore = before.flat();
  // Nothing gone and nothing come: the rows as they are.
  if (gone < 0 && flatBefore.length === ids.length && flatBefore.every((id, i) => ids[i] === id)) return before.map((row) => [...row]);
  // Nothing gone: the files come join the last row.
  const touched = gone >= 0 ? gone : Math.max(0, before.length - 1);
  const kept = before.slice(0, touched).map((row) => [...row]);
  const flat = kept.flat();
  // The same files in another order: anew.
  if (!flat.every((id, i) => ids[i] === id)) return anew(ids);
  return [...kept, ...anew(ids.slice(flat.length))];
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
