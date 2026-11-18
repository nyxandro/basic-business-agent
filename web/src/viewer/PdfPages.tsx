// The pages of a PDF (spec, section 8.27): PDF.js's own viewer component — pages drawn as they come into
// view, text that can be selected and copied, links that open in a new tab — with our scale (zoom.ts).
// As in Yana (D-69): no borders round the pages, the fit to the width applied again when the screen turns,
// and on closing the viewer is stopped before the loading of the document is broken off — otherwise its
// queue of drawing goes on into a destroyed document.
import 'pdfjs-dist/legacy/web/pdf_viewer.css';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { ru } from '../i18n/ru.ts';
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
      eventBus.on('scalechanging', ({ scale }: { scale: number }) => onScale(scale));
      eventBus.on('pagesinit', () => {
        fit();
        container.scrollTop = 0;
        if (active) onReady();
      });
      release.push(attachPinch(container, { read: () => viewer.currentScale, apply: set }));
      const resized = new ResizeObserver(() => {
        if (fitted) fit();
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
  }, [url]);

  // PDF.js scrolls the container itself and needs it positioned; `.pdfViewer` it fills with pages.
  return (
    <div ref={box} className={styles.pdf} aria-label={label} tabIndex={0}>
      <div className="pdfViewer" />
    </div>
  );
}
