// PDF.js for the viewer (spec, section 8.27): loaded when a document is first opened, not with the chat.
// The `legacy` build: the usual one of 6.5 needs the newest JavaScript (`Map.prototype.getOrInsertComputed`,
// `Math.sumPrecise`…) and fails on many phones; the legacy one carries what is missing. Order matters: the
// worker's address is set before the first document, and the viewer components take the core from the
// global `pdfjsLib`, so they are loaded after it.
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

type PdfjsCore = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

// The files PDF.js reads besides the document: without them a PDF with fonts not built in draws Cyrillic
// wrong, and pictures of scans (JPEG 2000, JBIG2) come out blank (web/vite.config.ts serves them).
export const PDFJS_ASSETS = {
  cMapUrl: '/pdfjs/cmaps/',
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  iccUrl: '/pdfjs/iccs/',
} as const;

let core: Promise<PdfjsCore> | null = null;

export function loadPdfjs(): Promise<PdfjsCore> {
  core ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = workerSrc;
    (globalThis as typeof globalThis & { pdfjsLib?: PdfjsCore }).pdfjsLib = lib;
    return lib;
  });
  return core;
}

export async function loadViewerComponents() {
  await loadPdfjs();
  return import('pdfjs-dist/legacy/web/pdf_viewer.mjs');
}
