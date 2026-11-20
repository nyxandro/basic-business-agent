// A mark removed turns to sand, as a file removed from the next message (request of the owner 20.11; ui/dissolve.ts):
// the shape with its number, in its colours, from where it stands on the page; its row of the list — the same way.
import { stillMotion, turnSvgToSand, turnToSand } from '../../ui/dissolve.ts';

// Room round the shape: its line and its number reach out of the outline the browser measures.
const ROOM = 8;

// The sand is only a picture: whatever goes wrong with it, the mark is still removed.
export function markToSand(id: string): void {
  if (stillMotion()) return;
  try {
    sand(id);
  } catch (error) {
    console.warn('sand failed', error);
  }
}

function sand(id: string): void {
  const mark = document.querySelector<SVGGElement>(`[data-mark-id="${id}"]`);
  turnToSand(document.querySelector<HTMLElement>(`[data-mark-row="${id}"]`));
  const page = mark?.ownerSVGElement;
  if (!mark || !page) return;
  const line = mark.querySelector<SVGPathElement>('[data-mark-line]');
  const badge = mark.querySelector<SVGTextElement>('text');
  const color = line ? getComputedStyle(line).stroke : '';
  const copy = mark.cloneNode(true) as SVGGElement;
  // The picture knows no CSS of the page: the colours and the look go into it as they are now.
  copy.querySelector('[data-mark-hit]')?.remove();
  copy.removeAttribute('class');
  copy.querySelectorAll('[class]').forEach((node) => node.removeAttribute('class'));
  const drawn = copy.querySelector('[data-mark-line]');
  drawn?.setAttribute('stroke', color);
  drawn?.setAttribute('fill', 'none');
  drawn?.setAttribute('stroke-linecap', 'round');
  drawn?.setAttribute('stroke-linejoin', 'round');
  copy.querySelector('circle')?.setAttribute('fill', color);
  const text = copy.querySelector('text');
  if (text && badge) {
    const style = getComputedStyle(badge);
    text.setAttribute('fill', style.fill);
    text.setAttribute('font-weight', style.fontWeight);
    text.setAttribute('font-family', style.fontFamily);
    text.setAttribute('text-anchor', 'middle');
  }
  const shape = mark.getBBox();
  const at = page.getBoundingClientRect();
  const box = { left: at.left + shape.x - ROOM, top: at.top + shape.y - ROOM, w: shape.width + ROOM * 2, h: shape.height + ROOM * 2 };
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${box.w}" height="${box.h}" viewBox="${shape.x - ROOM} ${shape.y - ROOM} ${box.w} ${box.h}">${new XMLSerializer().serializeToString(copy)}</svg>`;
  turnSvgToSand(markup, box);
}
