// The pages of a PDF (spec, section 8.27): PDF.js's own viewer component — pages drawn as they come into
// view, text that can be selected and copied, links that open in a new tab — with our scale (zoom.ts).
// As in Yana (D-69): no borders round the pages, the fit to the width applied again when the screen turns,
// and on closing the viewer is stopped before the loading of the document is broken off — otherwise its
// queue of drawing goes on into a destroyed document.
import 'pdfjs-dist/legacy/web/pdf_viewer.css';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { ru } from '../i18n/ru.ts';
import { MarksLayer } from './marks/MarksLayer.tsx';
import { pdfMarksDocument } from './marks/pdf-document.ts';
import type { PageBox } from './marks/types.ts';
import { useMarks } from './marks/use-marks.ts';
import { PDFJS_ASSETS, loadPdfjs, loadViewerComponents } from './pdfjs.ts';
import type { ViewerFailure, ZoomControl } from './types.ts';
import { attachPinch, clampZoom, fitScale, zoomIn, zoomOut } from './zoom.ts';
import styles from './viewer.module.css';


// The width of a page at 100 % (CSS pixels of PDF points).
const PX_PER_PT = 96 / 72;

// The default export: the viewer loads it, with the styles of PDF.js, only when a PDF is opened.
export default function PdfPages({ url, label, zoom, onScale, onReady, onFailure }: { url: string; label: string; zoom: Ref<ZoomControl>; onScale: (scale: number) => void; onReady: () => void; onFailure: (failure: ViewerFailure) => void }) {
  const box = useRef<HTMLDivElement>(null);
  // The scale of the open document; nothing to scale until it opens.
  const control = useRef<ZoomControl | null>(null);
  useImperativeHandle(zoom, () => ({ zoomIn: () => control.current?.zoomIn(), zoomOut: () => control.current?.zoomOut(), fit: () => control.current?.fit() }));
  // The marks of the viewer opened from the chat (spec, section 8.32): where the pages are, for the layer over them.
  const marks = useMarks();
  // The same function for the whole life of the viewer (use-marks.ts).
  const attach = marks?.attach;
  const [pages, setPages] = useState<PageBox[]>([]);

  useEffect(() => {
    const container = box.current;
    if (!container) return;
    let active = true;
    // Released in the order they were made: the viewer first, then the loading.
    const release: (() => void)[] = [];

    const open = async () => {
      const { EventBus, PDFViewer, PDFLinkService, LinkTarget } = await loadViewerComponents();
      const pdfjs = await loadPdfjs();
      if (!active) return;
      const eventBus = new EventBus();
      const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer' });
      const viewer = new PDFViewer({ container, eventBus, linkService, removePageBorders: true });
      linkService.setViewer(viewer);
      release.push(() => viewer.setDocument(null));
      // The page fitted to the width while nobody chose a scale; a scale chosen stays when the screen turns.
      let fitted = true;
      const fit = () => {
        // PDF.js types the page view as any: the width of its viewport at the scale it has.
        const page = viewer.getPageView(0) as { viewport: { width: number; scale: number } } | undefined;
        if (!page) return;
        fitted = true;
        viewer.currentScale = fitScale(container.clientWidth, (page.viewport.width / page.viewport.scale) * PX_PER_PT);
      };
      const set = (scale: number) => {
        fitted = false;
        viewer.currentScale = clampZoom(scale);
      };
      control.current = { zoomIn: () => set(zoomIn(viewer.currentScale)), zoomOut: () => set(zoomOut(viewer.currentScale)), fit };
      release.push(() => {
        control.current = null;
      });
      // Where every page is in the scrolled area, measured after the browser laid the pages out anew.
      let measuring = 0;
      const measure = () => {
        if (!attach) return;
        cancelAnimationFrame(measuring);
        measuring = requestAnimationFrame(() => {
          const area = container.getBoundingClientRect();
          const boxes: PageBox[] = [];
          for (let i = 0; i < viewer.pagesCount; i++) {
            // PDF.js types the page view as any: its element.
            const div = (viewer.getPageView(i) as { div?: HTMLElement } | undefined)?.div;
            if (!div) continue;
            const rect = div.getBoundingClientRect();
            boxes.push({ page: i + 1, left: rect.left - area.left + container.scrollLeft - container.clientLeft, top: rect.top - area.top + container.scrollTop - container.clientTop, width: rect.width, height: rect.height });
          }
          if (active) setPages(boxes);
        });
      };
      release.push(() => cancelAnimationFrame(measuring));
      eventBus.on('scalechanging', ({ scale }: { scale: number }) => {
        onScale(scale);
        measure();
      });
      eventBus.on('pagesinit', () => {
        fit();
        container.scrollTop = 0;
        measure();
        if (active) onReady();
      });
      // PDF.js lays every page out at the size of the first one, then gives each its own as it reads it, with no event:
      // the pages' column changing its size is the sign (a book of Excel sheets, a Word with a landscape part).
      eventBus.on('pagesloaded', measure);
      const laidOut = new ResizeObserver(measure);
      laidOut.observe(container.querySelector('.pdfViewer')!);
      release.push(() => laidOut.disconnect());
      release.push(attachPinch(container, { read: () => viewer.currentScale, apply: set }));
      const resized = new ResizeObserver(() => {
        if (fitted) fit();
        measure();
      });
      resized.observe(container);
      release.push(() => resized.disconnect());

      const task = pdfjs.getDocument({ url, ...PDFJS_ASSETS });
      release.push(() => void task.destroy());
      // A password is not asked: the document is to be downloaded (spec, section 8.27).
      task.onPassword = () => {
        if (active) onFailure({ code: 'APP_PREVIEW_PASSWORD', message: ru.clientErrors.APP_PREVIEW_PASSWORD });
        void task.destroy();
      };
      const document = await task.promise;
      if (!active) return;
      viewer.setDocument(document);
      linkService.setDocument(document);
      attach?.(pdfMarksDocument(document, viewer, container));
      release.push(() => attach?.(null));
    };

    open().catch((error: unknown) => {
      if (!active) return;
      // A password already told; anything else — a damaged file, a worker that did not start.
      if ((error as { name?: string } | null)?.name === 'PasswordException') return;
      console.error('APP_PREVIEW_FAILED: the PDF did not open', error);
      onFailure({ code: 'APP_PREVIEW_FAILED', message: ru.clientErrors.APP_PREVIEW_FAILED });
    });
    return () => {
      active = false;
      for (const done of release) done();
    };
    // The document is opened once per address; the callbacks of the viewer do not reopen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, attach]);

  // PDF.js scrolls the container itself and needs it positioned; `.pdfViewer` it fills with pages.
  return (
    <div ref={box} className={styles.pdf} aria-label={label} tabIndex={0}>
      <div className="pdfViewer" />
      {marks ? <MarksLayer pages={pages} scroller={() => box.current} /> : null}
    </div>
  );
}
