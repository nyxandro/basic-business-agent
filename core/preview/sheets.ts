// How a workbook is shown (spec, section 8.27; step 114): LibreOffice's «whole sheet on one page»
// (`SinglePageSheets`) is the closest to Excel, but a PDF page is at most ~14 400 pt — a bigger sheet it
// shrinks whole and, from ~1 000 rows, cuts without an error; and it gives every sheet a page, the
// hidden ones too, in the order of the sheets. So the sizes of the visible sheets are read from the file
// first: all fit — whole sheets, and the pages of the hidden sheets are dropped afterwards; one does not —
// the whole workbook in pages, as it prints (that loses nothing and leaves hidden sheets out by itself).
// Whatever cannot be measured — a sheet not found, a part too big to unpack, a file not read — prints in
// pages too. Parts are unpacked in the server's own thread, so a big one is never unpacked at all.
import { strFromU8, unzipSync } from 'fflate';

// A little under the page limit of a PDF, where LibreOffice starts to shrink the sheet.
export const SHEET_PAGE_LIMIT_PT = 14_000;
// Excel's defaults when the sheet names none: a row of 15 pt, a column of 8.43 characters.
const DEFAULT_ROW_PT = 15;
const DEFAULT_COLUMN_CHARS = 8.43;
// A part of a workbook bigger than this unpacked is not read: a sheet whose description takes megabytes is
// far taller than a page anyway (a measured sheet of 900 rows takes ~150 KB), and a crafted one would hold
// the server for seconds and gigabytes.
const PART_MAX_BYTES = 2 * 1024 * 1024;
// Any prefix of a namespace: Excel writes «<sheet», the Open XML SDK «<x:sheet».
const NS = '(?:[\\w-]+:)?';

export interface SheetPlan {
  // Every visible sheet fits a page: «whole sheet on one page»; otherwise the workbook in pages.
  singlePage: boolean;
  // Pages (from 1) of the hidden sheets in the «whole sheet» PDF.
  hiddenPages: number[];
  // Sheets of the workbook: a page each in the «whole sheet» PDF.
  sheets: number;
}

const tags = (xml: string, name: string) => xml.matchAll(new RegExp(`<${NS}${name}\\b([^>]*)>`, 'g'));

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match ? (match[1] ?? match[2]) : undefined;
}

// «r:id» with whatever prefix the writer chose for the relationships' namespace.
function relationId(tag: string): string | undefined {
  const match = /(?:^|\s)[\w-]+:id\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
  return match ? (match[1] ?? match[2]) : undefined;
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
  const format = tags(xml, 'sheetFormatPr').next().value?.[1] ?? '';
  const rowPt = Number(attr(format, 'defaultRowHeight') ?? DEFAULT_ROW_PT);
  let last = 0;
  let custom = 0;
  let customPt = 0;
  for (const match of tags(xml, 'row')) {
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
  const dimension = /^[A-Z]+\d+:([A-Z]+)\d+$/.exec(attr(tags(xml, 'dimension').next().value?.[1] ?? '', 'ref') ?? '')?.[1];
  if (dimension) return columnIndex(dimension);
  let last = 0;
  for (const match of tags(xml, 'row')) last = Math.max(last, Number(/^\d+:(\d+)$/.exec(attr(match[1]!, 'spans') ?? '')?.[1] ?? 0));
  if (last > 0) return last;
  for (const match of tags(xml, 'c')) last = Math.max(last, columnIndex(/^([A-Z]+)\d+$/.exec(attr(match[1]!, 'r') ?? '')?.[1] ?? ''));
  return last;
}

function sheetWidth(xml: string): number {
  const format = tags(xml, 'sheetFormatPr').next().value?.[1] ?? '';
  const defaultChars = Number(attr(format, 'defaultColWidth') ?? DEFAULT_COLUMN_CHARS);
  const columns = lastColumn(xml);
  const widths = new Map<number, number>();
  for (const match of tags(xml, 'col')) {
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

// The plan of an `.xlsx`/`.xlsm`; null when the file is not one or cannot be read (LibreOffice then prints
// it in pages, or says it cannot read it).
export function planSheets(bytes: Uint8Array): SheetPlan | null {
  try {
    return plan(bytes);
  } catch {
    // A part that is not text, a zip that is not one: nothing to measure by — the workbook prints in pages.
    return null;
  }
}

function plan(bytes: Uint8Array): SheetPlan | null {
  const tooBig = new Set<string>();
  const files = unzipSync(bytes, {
    filter: (file) => {
      if (!file.name.startsWith('xl/') || !(file.name.endsWith('.xml') || file.name.endsWith('.rels'))) return false;
      if (file.originalSize <= PART_MAX_BYTES) return true;
      tooBig.add(file.name);
      return false;
    },
  });
  const book = files['xl/workbook.xml'];
  const rels = files['xl/_rels/workbook.xml.rels'];
  if (!book || !rels) return null;
  const targets = new Map<string, { path: string; worksheet: boolean }>();
  for (const match of tags(strFromU8(rels), 'Relationship')) {
    const id = attr(match[1]!, 'Id');
    const target = attr(match[1]!, 'Target');
    const type = attr(match[1]!, 'Type') ?? '';
    if (id && target) targets.set(id, { path: partPath(target), worksheet: type.endsWith('/worksheet') });
  }
  const sheets = [...tags(strFromU8(book), 'sheet')].map((match) => match[1]!);
  const hiddenPages: number[] = [];
  let singlePage = sheets.length > 0;
  sheets.forEach((tag, i) => {
    const state = attr(tag, 'state');
    if (state === 'hidden' || state === 'veryHidden') {
      hiddenPages.push(i + 1);
      return;
    }
    const target = targets.get(relationId(tag) ?? '');
    // A chart sheet (no cells) takes one page of its own size.
    if (target && !target.worksheet && !tooBig.has(target.path)) return;
    const part = target ? files[target.path] : undefined;
    if (!part) {
      // Not found or too big to read: it cannot be measured.
      singlePage = false;
      return;
    }
    const xml = strFromU8(part);
    if (sheetHeight(xml) > SHEET_PAGE_LIMIT_PT || sheetWidth(xml) > SHEET_PAGE_LIMIT_PT) singlePage = false;
  });
  return { singlePage, hiddenPages, sheets: sheets.length };
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') return String.fromCodePoint(ref[1]?.toLowerCase() === 'x' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1)));
    return XML_ENTITIES[ref] ?? whole;
  });
}

// The sheets of an `.xlsx`/`.xlsm` in their order, with whether each is hidden — the text of a workbook leaves
// the hidden ones out, as the viewer does (spec, section 8.29); null — not a workbook that can be read.
export function sheetNames(bytes: Uint8Array): { name: string; hidden: boolean }[] | null {
  try {
    const book = unzipSync(bytes, { filter: (file) => file.name === 'xl/workbook.xml' && file.originalSize <= PART_MAX_BYTES })['xl/workbook.xml'];
    if (!book) return null;
    return [...tags(strFromU8(book), 'sheet')].map((match) => {
      const state = attr(match[1]!, 'state');
      return { name: unescapeXml(attr(match[1]!, 'name') ?? ''), hidden: state === 'hidden' || state === 'veryHidden' };
    });
  } catch {
    // Not a zip, or its book is not text: the workbook gives no text.
    return null;
  }
}
