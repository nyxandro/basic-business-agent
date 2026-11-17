// How a workbook is shown (spec, section 8.27; step 114): LibreOffice's «whole sheet on one page»
// (`SinglePageSheets`) is the closest to Excel, but a PDF page is at most ~14 400 pt — a bigger sheet it
// shrinks whole and, from ~1 000 rows, cuts without an error; and it gives every sheet a page, the
// hidden ones too, in the order of the sheets. So the sizes of the visible sheets are read from the file
// first: all fit — whole sheets, and the pages of the hidden sheets are dropped afterwards; one does not —
// the whole workbook in pages, as it prints (that loses nothing and leaves hidden sheets out by itself).
import { strFromU8, unzipSync } from 'fflate';

// A little under the page limit of a PDF, where LibreOffice starts to shrink the sheet.
export const SHEET_PAGE_LIMIT_PT = 14_000;
// Excel's defaults when the sheet names none: a row of 15 pt, a column of 8.43 characters.
const DEFAULT_ROW_PT = 15;
const DEFAULT_COLUMN_CHARS = 8.43;

export interface SheetPlan {
  // Every visible sheet fits a page: «whole sheet on one page»; otherwise the workbook in pages.
  singlePage: boolean;
  // Pages (from 1) of the hidden sheets in the «whole sheet» PDF.
  hiddenPages: number[];
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1];
}

// «r:id» with whatever prefix the writer chose for the relationships' namespace.
function relationId(tag: string): string | undefined {
  return /(?:^|\s)[\w-]+:id="([^"]*)"/.exec(tag)?.[1];
}

function columnIndex(letters: string): number {
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

// Excel's column width in characters to points: the width of a character of the default font (7 px)
// and the padding of a cell (5 px), at 96 px to 72 pt.
function columnPt(chars: number): number {
  return (chars * 7 + 5) * 0.75;
}

function sheetHeight(xml: string): number {
  const format = /<sheetFormatPr\b([^>]*)>/.exec(xml)?.[1] ?? '';
  const rowPt = Number(attr(format, 'defaultRowHeight') ?? DEFAULT_ROW_PT);
  let last = 0;
  let custom = 0;
  let customPt = 0;
  for (const match of xml.matchAll(/<row\b([^>]*)>/g)) {
    const tag = match[1]!;
    const r = attr(tag, 'r');
    last = r ? Number(r) : last + 1;
    const ht = attr(tag, 'ht');
    if (ht !== undefined) {
      custom++;
      customPt += Number(ht);
    }
  }
  return (last - custom) * rowPt + customPt;
}

function lastColumn(xml: string): number {
  const dimension = /<dimension\b[^>]*\bref="[A-Z]+\d+:([A-Z]+)\d+"/.exec(xml)?.[1];
  if (dimension) return columnIndex(dimension);
  let last = 0;
  for (const match of xml.matchAll(/\bspans="\d+:(\d+)"/g)) last = Math.max(last, Number(match[1]));
  if (last > 0) return last;
  for (const match of xml.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"/g)) last = Math.max(last, columnIndex(match[1]!));
  return last;
}

function sheetWidth(xml: string): number {
  const format = /<sheetFormatPr\b([^>]*)>/.exec(xml)?.[1] ?? '';
  const defaultChars = Number(attr(format, 'defaultColWidth') ?? DEFAULT_COLUMN_CHARS);
  const columns = lastColumn(xml);
  const widths = new Map<number, number>();
  for (const match of xml.matchAll(/<col\b([^>]*)>/g)) {
    const tag = match[1]!;
    const width = Number(attr(tag, 'width') ?? defaultChars);
    for (let i = Number(attr(tag, 'min')); i <= Math.min(Number(attr(tag, 'max')), columns); i++) widths.set(i, width);
  }
  let total = 0;
  for (let i = 1; i <= columns; i++) total += columnPt(widths.get(i) ?? defaultChars);
  return total;
}

// A workbook's target of a relationship, from `xl/` or from the root of the archive.
function partPath(target: string): string {
  return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
}

// The plan of an `.xlsx`/`.xlsm`; null when the file is not one (LibreOffice then prints it in pages, or
// says it cannot read it).
export function planSheets(bytes: Uint8Array): SheetPlan | null {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (file) => file.name.startsWith('xl/') && (file.name.endsWith('.xml') || file.name.endsWith('.rels')) });
  } catch {
    // Not a zip archive: there is nothing to plan by.
    return null;
  }
  const book = files['xl/workbook.xml'];
  const rels = files['xl/_rels/workbook.xml.rels'];
  if (!book || !rels) return null;
  const targets = new Map<string, string>();
  for (const match of strFromU8(rels).matchAll(/<Relationship\b([^>]*)>/g)) {
    const id = attr(match[1]!, 'Id');
    const target = attr(match[1]!, 'Target');
    if (id && target) targets.set(id, partPath(target));
  }
  const hiddenPages: number[] = [];
  let singlePage = true;
  [...strFromU8(book).matchAll(/<sheet\b([^>]*)>/g)].forEach((match, i) => {
    const tag = match[1]!;
    const state = attr(tag, 'state');
    if (state === 'hidden' || state === 'veryHidden') {
      hiddenPages.push(i + 1);
      return;
    }
    const id = relationId(tag);
    const part = id ? files[targets.get(id) ?? ''] : undefined;
    // A chart sheet (no cells) or a part that is not there takes one page of its own size.
    if (!part || !targets.get(id!)?.includes('worksheets/')) return;
    const xml = strFromU8(part);
    if (sheetHeight(xml) > SHEET_PAGE_LIMIT_PT || sheetWidth(xml) > SHEET_PAGE_LIMIT_PT) singlePage = false;
  });
  return { singlePage, hiddenPages };
}
