// A scrolling area whose scrollbar shows only while it scrolls and fades out after (owner 25.11). The browser's own
// scrollbar can't fade — it is hidden; a thumb of our own follows the list and is dragged with the mouse. The wheel,
// the keyboard and a finger scroll the area as usual.
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cx } from './Button.tsx';
import styles from './scroll-area.module.css';

// How long after the last scroll the thumb starts to fade.
export const SCROLL_IDLE_MS = 900;
// A shorter thumb would be hard to catch on a long list.
const THUMB_MIN_PX = 24;
// The thumb's way keeps clear of the top and bottom edges of the area.
const EDGE_PX = 4;

// The thumb's way and length; null — nothing to scroll (or the area is too low for a thumb).
function geometry(view: HTMLElement): { way: number; size: number; travel: number } | null {
  const { clientHeight, scrollHeight } = view;
  const travel = scrollHeight - clientHeight;
  if (travel < 1) return null;
  const way = clientHeight - 2 * EDGE_PX;
  const size = Math.max(THUMB_MIN_PX, (way * clientHeight) / scrollHeight);
  return size < way ? { way, size, travel } : null;
}

export function ScrollArea({ className, contentClassName, children }: { className?: string; contentClassName?: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  // Undoes the drag under way, when the area goes away in the middle of it.
  const stopDrag = useRef<(() => void) | null>(null);

  useEffect(() => {
    const [box, view, inner, bar] = [root.current, viewport.current, content.current, thumb.current];
    if (!box || !view || !inner || !bar) return;
    let idle: ReturnType<typeof setTimeout> | undefined;
    // Written straight into the page, not through React: a scroll moves the thumb many times a second.
    const place = () => {
      const g = geometry(view);
      box.toggleAttribute('data-overflow', g !== null);
      if (!g) return;
      bar.style.height = `${g.size}px`;
      bar.style.transform = `translateY(${EDGE_PX + ((g.way - g.size) * view.scrollTop) / g.travel}px)`;
    };
    const onScroll = () => {
      place();
      box.setAttribute('data-scrolling', '');
      clearTimeout(idle);
      idle = setTimeout(() => box.removeAttribute('data-scrolling'), SCROLL_IDLE_MS);
    };
    place();
    view.addEventListener('scroll', onScroll, { passive: true });
    // The list grows as it loads and the window changes its height: the thumb follows both.
    const observer = new ResizeObserver(place);
    observer.observe(view);
    observer.observe(inner);
    return () => {
      clearTimeout(idle);
      view.removeEventListener('scroll', onScroll);
      observer.disconnect();
      stopDrag.current?.();
    };
  }, []);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const [box, view] = [root.current, viewport.current];
    if (event.button !== 0 || !box || !view) return;
    // No text gets selected while the hand moves the thumb.
    event.preventDefault();
    const from = { y: event.clientY, top: view.scrollTop };
    // Followed on the whole window: the pointer leaves the thin thumb at once.
    const move = (e: PointerEvent) => {
      // The button let go where no release reached the page (Alt+Tab in the middle): the list stops following.
      if ((e.buttons & 1) === 0) {
        stop();
        return;
      }
      const g = geometry(view);
      if (!g) return;
      const top = from.top + ((e.clientY - from.y) * g.travel) / (g.way - g.size);
      view.scrollTop = Math.min(g.travel, Math.max(0, top));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      box.removeAttribute('data-dragging');
      stopDrag.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    box.setAttribute('data-dragging', '');
    stopDrag.current = stop;
  };

  return (
    <div ref={root} className={cx(styles.root, className)} data-scroll-area="">
      <div ref={viewport} className={styles.viewport}>
        <div ref={content} className={contentClassName}>
          {children}
        </div>
      </div>
      <div ref={thumb} className={styles.thumb} aria-hidden="true" onPointerDown={startDrag} />
    </div>
  );
}
