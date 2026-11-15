// What a line unfolds grows out from under it and folds back into it (decision of the owner 15.11),
// instead of appearing and vanishing at once: the box goes from no height to the height of its content
// and fades in, and back. While it folds, the content stays on screen and goes only after the fold.
// A click midway turns it back from where it is. With «уменьшить движение» in the system the content
// simply appears and goes.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const UNFOLD: KeyframeAnimationOptions = { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' };
const FOLD: KeyframeAnimationOptions = { duration: 200, easing: 'cubic-bezier(0.4, 0, 0.6, 1)' };

interface Frame {
  height: number;
  opacity: number;
}

const stillMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(open);
  // It comes at once; it goes at once only without motion, otherwise once it has folded.
  if (open !== mounted && (open || stillMotion())) setMounted(open);
  const box = useRef<HTMLDivElement>(null);
  const running = useRef<Animation | null>(null);
  const wasOpen = useRef(open);

  useLayoutEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    const el = box.current;
    const midway: Frame | null = el && running.current ? { height: el.getBoundingClientRect().height, opacity: Number(getComputedStyle(el).opacity) } : null;
    running.current?.cancel();
    running.current = null;
    if (!el || stillMotion()) return;
    // A fold that has ended holds the box shut until it goes; turned back then, it opens from there.
    el.style.height = '';
    el.style.opacity = '';
    const full: Frame = { height: el.getBoundingClientRect().height, opacity: 1 };
    const none: Frame = { height: 0, opacity: 0 };
    const from = midway ?? (open ? none : full);
    const to = open ? full : none;
    // Clipped only while it moves: at rest the focus ring of a line inside must not be cut off.
    el.style.overflow = 'hidden';
    const animation = el.animate(
      [
        { height: `${from.height}px`, opacity: from.opacity },
        { height: `${to.height}px`, opacity: to.opacity },
      ],
      open ? UNFOLD : FOLD,
    );
    running.current = animation;
    animation.onfinish = () => {
      running.current = null;
      if (open) {
        el.style.overflow = '';
        return;
      }
      // Without this the box stands at full height for a frame before React takes it away.
      el.style.height = '0px';
      el.style.opacity = '0';
      setMounted(false);
    };
  }, [open]);

  useLayoutEffect(() => () => running.current?.cancel(), []);

  if (!mounted) return null;
  return (
    <div ref={box} className={className}>
      {children}
    </div>
  );
}
