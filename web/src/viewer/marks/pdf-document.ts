// What the pages of a PDF give the marks (spec, section 8.32): the text under a mark from the text PDF.js reads of
// its page, the picture of the marks drawn by PDF.js only within each band, scrolling to a mark.
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { marksPicture, type PicturePage } from './picture.ts';
import { textBoxes, textUnder, type TextBox } from './text-under.ts';
import type { Mark, MarksDocument } from './types.ts';

// A mark scrolled to stands this far from the top of the view: what is above it is seen too.
const REVEAL_FROM_TOP = 1 / 3;

interface PageViews {
  getPageView(index: number): unknown;
}

export function pdfMarksDocument(document: PDFDocumentProxy, viewer: PageViews, container: HTMLElement): MarksDocument {
  // The text of a page is read once, when the first mark of it is sent.
  const texts = new Map<number, Promise<{ boxes: TextBox[]; aspect: number }>>();
  const textOf = (number: number) => {
    let text = texts.get(number);
    if (!text) {
      text = document.getPage(number).then(async (page) => {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        return { boxes: textBoxes(content.items, viewport), aspect: viewport.height / viewport.width };
      });
      texts.set(number, text);
    }
    return text;
  };
  const pictured = (page: PDFPageProxy): PicturePage => {
    const whole = page.getViewport({ scale: 1 });
    return {
      page: page.pageNumber,
      width: whole.width,
      height: whole.height,
      // Only the band is drawn: a sheet of Excel «whole» at full size would not fit a canvas of a phone.
      draw: async (canvas, region, scale) => {
        const viewport = page.getViewport({ scale, offsetX: -region.x0 * whole.width * scale, offsetY: -region.y0 * whole.height * scale });
        await page.render({ canvas, viewport }).promise;
      },
    };
  };
  return {
    quote: async (mark: Mark) => {
      const { boxes, aspect } = await textOf(mark.page);
      return textUnder(mark, boxes, aspect);
    },
    picture: async (marks) => {
      const numbers = [...new Set(marks.map((m) => m.page))];
      const pages = await Promise.all(numbers.map(async (n) => pictured(await document.getPage(n))));
      return marksPicture(pages, marks, true);
    },
    reveal: (mark) => {
      // PDF.js types the page view as any: its element.
      const div = (viewer.getPageView(mark.page - 1) as { div?: HTMLElement } | undefined)?.div;
      if (!div) return;
      const area = container.getBoundingClientRect();
      const rect = div.getBoundingClientRect();
      const y = Math.min(...mark.points.map((p) => p.y));
      const top = rect.top - area.top + container.scrollTop + y * rect.height - container.clientHeight * REVEAL_FROM_TOP;
      container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    },
  };
}
