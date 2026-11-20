// Selected text becomes a mark by itself (request of the owner 20.11; spec, section 8.32): with «Пометки» on and no
// tool chosen, text selected in the pages of a PDF is filled as with a marker, and the window of its comment opens.
// The mark keeps the text exactly as selected — the agent gets the words, not a guess from a frame.
import { clampShare } from './geometry.ts';
import { COMMENT_MAX, type Point } from './types.ts';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Pieces of one line overlap by at least this part of the lower of them.
const SAME_LINE = 0.5;

// The boxes the browser gives for the selected text (a piece a span of PDF.js) — one box a line, as shares of the
// page: two corners a line, from the top line down.
export function lineRects(rects: readonly (Box & { right: number; bottom: number })[], page: Box): Point[] {
  const seen = rects.filter((r) => r.width > 0 && r.height > 0 && r.right > page.left && r.left < page.left + page.width && r.bottom > page.top && r.top < page.top + page.height);
  const lines: { top: number; bottom: number; left: number; right: number }[] = [];
  for (const r of [...seen].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const line = lines.find((l) => Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) >= SAME_LINE * Math.min(l.bottom - l.top, r.height));
    if (line) {
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
    } else lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
  }
  const x = (v: number) => clampShare((v - page.left) / page.width);
  const y = (v: number) => clampShare((v - page.top) / page.height);
  return lines.flatMap((l) => [
    { x: x(l.left), y: y(l.top) },
    { x: x(l.right), y: y(l.bottom) },
  ]);
}

// Text nodes of the text layer the range takes in, each cut to the range.
function textPieces(range: Range): Range[] {
  const root = range.commonAncestorContainer;
  const pieces: Range[] = [];
  const walker = document.createTreeWalker(root.nodeType === Node.TEXT_NODE ? root.parentNode! : root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node) || !node.parentElement?.closest('.textLayer')) continue;
    const piece = document.createRange();
    piece.selectNodeContents(node);
    if (node === range.startContainer) piece.setStart(node, range.startOffset);
    if (node === range.endContainer) piece.setEnd(node, range.endOffset);
    pieces.push(piece);
  }
  return pieces;
}

// The mark of what is selected in the pages of `area`, on the page where the selection begins; null — nothing of
// the text of a page is selected.
export function selectionMark(selection: Selection | null, area: HTMLElement): { page: number; points: Point[]; text: string } | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start = range.startContainer.nodeType === Node.ELEMENT_NODE ? (range.startContainer as Element) : range.startContainer.parentElement;
  const pageElement = start?.closest<HTMLElement>('.page[data-page-number]');
  if (!pageElement || !area.contains(pageElement)) return null;
  const words = selection.toString().replace(/\s+/g, ' ').trim();
  if (!words) return null;
  const at = pageElement.getBoundingClientRect();
  const points = lineRects(
    textPieces(range).flatMap((piece) => [...piece.getClientRects()]),
    { left: at.left, top: at.top, width: at.width, height: at.height },
  );
  if (points.length === 0) return null;
  return { page: Number(pageElement.dataset.pageNumber), points, text: words.length > COMMENT_MAX ? `${words.slice(0, COMMENT_MAX - 1)}…` : words };
}
