// A box whose height follows its content over a moment instead of at once: what is above or below it
// glides (decision of the owner 17.11 — the input must not jump when its files change). The content
// takes its new size at once and is clipped while the box comes to it. With «уменьшить движение» in
// the system the box simply takes the height (Motion, reducedMotion of MotionConfig).
import { motion } from 'motion/react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { EASING, MOVE_S } from './motion.ts';

export function AutoHeight({ children, className }: { children: ReactNode; className?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>('auto');
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const watcher = new ResizeObserver(() => setHeight(el.getBoundingClientRect().height));
    watcher.observe(el);
    return () => watcher.disconnect();
  }, []);
  return (
    <motion.div className={className} initial={false} animate={{ height }} transition={{ duration: MOVE_S, ease: EASING }} style={{ overflow: 'hidden' }}>
      {/* What leaves is taken out of the flow and stays where it was (Motion, popLayout): it needs a place to
          stay in. Its own block, so the margins of what is inside are inside its height, not cut off. */}
      <div ref={inner} style={{ position: 'relative', display: 'flow-root' }}>
        {children}
      </div>
    </motion.div>
  );
}
