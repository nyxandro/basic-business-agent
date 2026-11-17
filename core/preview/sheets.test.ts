import fc from 'fast-check';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { planSheets, SHEET_PAGE_LIMIT_PT } from './sheets.ts';

interface Sheet {
  name: string;
  state?: 'hidden' | 'veryHidden';
  xml?: string;
  chart?: boolean;
  target?: string;
}

// A workbook as Excel and openpyxl write it: only the parts planSheets reads.
function workbook(sheets: Sheet[]): Uint8Array {
  const tags = sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`).join('');
  const rels = sheets
    .map((s, i) => {
      const type = s.chart ? 'chartsheet' : 'worksheet';
      return `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${s.target ?? `${type}s/sheet${i + 1}.xml`}"/>`;
    })
    .join('');
  const files: Zippable = {
    'xl/workbook.xml': strToU8(`<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${tags}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0"?><Relationships>${rels}</Relationships>`),
  };
  sheets.forEach((s, i) => {
    if (s.chart) return;
    const path = s.target ? s.target.replace(/^\//, '') : `xl/worksheets/sheet${i + 1}.xml`;
    files[path] = strToU8(s.xml ?? rows(3));
  });
  return zipSync(files);
}

function rows(count: number, attrs = '', format = ''): string {
  const body = Array.from({ length: count }, (_, i) => `<row r="${i + 1}"${attrs}><c r="A${i + 1}"><v>${i + 1}</v></c></row>`).join('');
  return `<worksheet>${format}<sheetData>${body}</sheetData></worksheet>`;
}

describe('which way a workbook is shown (spec, section 8.27)', () => {
  it('shows small sheets whole and drops the pages of the hidden ones, in the order of the sheets', () => {
    const plan = planSheets(workbook([{ name: 'Альфа' }, { name: 'Бета', state: 'hidden' }, { name: 'Пустой', xml: '<worksheet><sheetData/></worksheet>' }, { name: 'Дельта' }, { name: 'Совсем', state: 'veryHidden' }]));
    expect(plan).toEqual({ singlePage: true, hiddenPages: [2, 5] });
  });

  it('prints the workbook in pages when a visible sheet is taller than the page limit', () => {
    expect(planSheets(workbook([{ name: 'A', xml: rows(900) }]))?.singlePage).toBe(true);
    expect(planSheets(workbook([{ name: 'A', xml: rows(1000) }]))?.singlePage).toBe(false);
    // Rows with their own height count with it.
    expect(planSheets(workbook([{ name: 'A', xml: rows(500, ' ht="30" customHeight="1"') }]))?.singlePage).toBe(false);
    // The default height of the sheet.
    expect(planSheets(workbook([{ name: 'A', xml: rows(700, '', '<sheetFormatPr defaultRowHeight="20"/>') }]))?.singlePage).toBe(true);
    expect(planSheets(workbook([{ name: 'A', xml: rows(701, '', '<sheetFormatPr defaultRowHeight="20"/>') }]))?.singlePage).toBe(false);
  });

  it('counts the empty rows up to the last one, and only visible sheets', () => {
    const sparse = '<worksheet><sheetData><row r="1"><c r="A1"/></row><row r="2000"><c r="A2000"/></row></sheetData></worksheet>';
    expect(planSheets(workbook([{ name: 'A', xml: sparse }]))?.singlePage).toBe(false);
    expect(planSheets(workbook([{ name: 'A' }, { name: 'Скрытый', state: 'hidden', xml: rows(5000) }]))).toEqual({ singlePage: true, hiddenPages: [2] });
  });

  it('prints in pages a sheet wider than the limit, by the widths of its columns', () => {
    const wide = (cols: string, dim: string) => `<worksheet><dimension ref="${dim}"/>${cols}<sheetData>${'<row r="1"><c r="A1"/></row>'}</sheetData></worksheet>`;
    expect(planSheets(workbook([{ name: 'A', xml: wide('', 'A1:H10') }]))?.singlePage).toBe(true);
    expect(planSheets(workbook([{ name: 'A', xml: wide('', 'A1:ZZ10') }]))?.singlePage).toBe(false);
    expect(planSheets(workbook([{ name: 'A', xml: wide('<cols><col min="1" max="100" width="50" customWidth="1"/></cols>', 'A1:CV10') }]))?.singlePage).toBe(false);
  });

  it('keeps a chart sheet in the order of the pages, and finds sheets by an absolute path', () => {
    const plan = planSheets(workbook([{ name: 'Диаграмма', chart: true, state: 'hidden' }, { name: 'Данные', target: '/xl/worksheets/data.xml' }]));
    expect(plan).toEqual({ singlePage: true, hiddenPages: [1] });
  });

  it('has no plan for what is not a workbook: the converter prints it in pages', () => {
    expect(planSheets(strToU8('not a zip'))).toBeNull();
    expect(planSheets(zipSync({ 'word/document.xml': strToU8('<w/>') }))).toBeNull();
  });

  it('a sheet of rows of one height is shown whole exactly when they fit the limit', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1500 }), fc.integer({ min: 8, max: 40 }), (count, height) => {
        const plan = planSheets(workbook([{ name: 'A', xml: rows(count, '', `<sheetFormatPr defaultRowHeight="${height}"/>`) }]));
        expect(plan?.singlePage).toBe(count * height <= SHEET_PAGE_LIMIT_PT);
      }),
      { numRuns: 60 },
    );
  });
});
