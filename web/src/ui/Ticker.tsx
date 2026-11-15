// Content that changes like the wheel of the date picker on an iPhone (decision of the owner 15.11):
// when `value` changes, the old content turns away upwards past the top edge of the box it is in, and
// only then the new one comes from under its bottom edge — they do not meet in the middle (owner,
// 15.11); the box settles to the new width as it comes. The box that clips is the nearest ancestor with
// `overflow: hidden`. With «уменьшить движение» in the system the content simply changes.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from './Button.tsx';
import styles from './ticker.module.css';

const SETTLE_MS = 200;

export function Ticker({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  const [shown, setShown] = useState(value);
  const [current, setCurrent] = useState<ReactNode>(children);
  const [leaving, setLeaving] = useState<{ value: string; node: ReactNode } | null>(null);
  // The value whose content is still on its way in; it waits for the old one to go (ticker.module.css).
  const [arriving, setArriving] = useState<string | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const widthBefore = useRef<number | null>(null);
  if (value !== shown) {
    setShown(value);
    setCurrent(children);
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setLeaving({ value: shown, node: current });
      setArriving(value);
    }
  } else if (children !== current) {
    setCurrent(children);
  }

  // The box is as wide as the wider of the two until the old one has gone; then it settles to the new one.
  useLayoutEffect(() => {
    const from = widthBefore.current;
    widthBefore.current = null;
    const el = box.current;
    if (from === null || !el) return;
    const to = el.getBoundingClientRect().width;
    if (Math.abs(from - to) > 0.5) el.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: SETTLE_MS, easing: 'ease-out' });
  }, [leaving]);

  return (
    <span ref={box} className={cx(styles.ticker, className)}>
      {leaving ? (
        <span
          key={`out:${leaving.value}`}
          className={cx(styles.item, styles.out)}
          aria-hidden="true"
          onAnimationEnd={(e) => {
            if (e.target !== e.currentTarget) return;
            widthBefore.current = box.current?.getBoundingClientRect().width ?? null;
            setLeaving(null);
          }}
        >
          {leaving.node}
        </span>
      ) : null}
      <span key={`in:${value}`} className={cx(styles.item, arriving === value && styles.in)} onAnimationEnd={(e) => e.target === e.currentTarget && setArriving(null)}>
        {children}
      </span>
    </span>
  );
}
