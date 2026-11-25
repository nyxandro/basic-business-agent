// A small popover menu next to its button (settings, project of the conversation, row actions).
// It closes on a click outside and on Esc; the parent owns the open state. A `floating` menu (row
// actions of a table, owner's list 16.11) lies in the top layer of the page at its button: a table
// scrolls inside its box, and an ordinary menu of a lower row was cut by that box.
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './Button.tsx';
import { Icon, type IconName } from './Icon.tsx';
import styles from './overlay.module.css';

type Placement = 'top-start' | 'top-stretch' | 'bottom-end' | 'bottom-start';

// Between the button and a floating menu, and between the menu and the edge of the window.
const FLOAT_GAP_PX = 6;
const FLOAT_MARGIN_PX = 8;

export function MenuAnchor({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(styles.anchor, className)}>{children}</div>;
}

// Under the anchor, its edge on the side of `placement`; above it when the room below is short and
// above is more; never past the window.
function floatingPlace(anchor: HTMLElement, menu: HTMLElement, placement: Placement): CSSProperties {
  const a = anchor.getBoundingClientRect();
  const { clientWidth: viewWidth, clientHeight: viewHeight } = document.documentElement;
  const height = menu.offsetHeight;
  const width = menu.offsetWidth;
  const roomBelow = viewHeight - a.bottom - FLOAT_GAP_PX;
  const up = roomBelow < height && a.top > roomBelow;
  const top = up ? a.top - FLOAT_GAP_PX - height : a.bottom + FLOAT_GAP_PX;
  const left = placement === 'bottom-end' ? a.right - width : a.left;
  return {
    position: 'fixed',
    top: Math.max(FLOAT_MARGIN_PX, top),
    left: Math.min(Math.max(FLOAT_MARGIN_PX, left), viewWidth - width - FLOAT_MARGIN_PX),
  };
}

// The boxes around the anchor that cut what leaves them (a scrolling list, a table): the anchor is seen only inside them.
function clippingBoxes(anchor: HTMLElement): HTMLElement[] {
  const boxes: HTMLElement[] = [];
  for (let node = anchor.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(node);
    if (overflowX !== 'visible' || overflowY !== 'visible') boxes.push(node);
  }
  return boxes;
}

// Wholly past an edge of one of its boxes — the anchor is out of sight; partly seen still counts.
function inSight(anchor: HTMLElement, clips: HTMLElement[]): boolean {
  const a = anchor.getBoundingClientRect();
  return clips.every((clip) => {
    const c = clip.getBoundingClientRect();
    return a.bottom >= c.top && a.top <= c.bottom && a.right >= c.left && a.left <= c.right;
  });
}

export function Menu({ open, onClose, label, placement = 'bottom-end', children, role = 'menu', width, floating }: { open: boolean; onClose: () => void; label: string; placement?: Placement; children: ReactNode; role?: 'menu' | 'dialog'; width?: number; floating?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  // A floating menu is drawn elsewhere: this mark stays in the anchor to find it.
  const spot = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const close = useEffectEvent(onClose);

  useEffect(() => {
    if (!open) return;
    const anchorOf = () => (floating ? spot.current?.parentElement : box.current?.parentElement) ?? null;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const anchor = anchorOf();
      if (anchor && !anchor.contains(target) && !box.current?.contains(target)) close();
    };
    const buttonOf = () => anchorOf()?.querySelector<HTMLElement>('button') ?? null;
    const onKey = (event: KeyboardEvent) => {
      const inside = floating && box.current?.contains(document.activeElement);
      if (event.key === 'Escape') {
        // The keyboard went into a floating menu: it comes back to the button.
        if (inside) buttonOf()?.focus();
        close();
        return;
      }
      // A floating menu lies at the end of the page: Tab past its last item (Shift+Tab before its
      // first) goes on from its button, as if the menu stood next to it, and the menu closes.
      if (event.key !== 'Tab' || !inside) return;
      const items = [...(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
      const edge = event.shiftKey ? items[0] : items.at(-1);
      if (document.activeElement !== edge) return;
      if (event.shiftKey) event.preventDefault();
      buttonOf()?.focus();
      close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, floating]);

  useLayoutEffect(() => {
    const anchor = spot.current?.parentElement;
    if (!open || !floating || !anchor) return;
    const clips = clippingBoxes(anchor);
    // Away from the page's flow, the menu follows its button every frame: a scroll, the window, and a list rebuilt
    // under it (a conversation went up after an answer) move the button without a scroll or a resize. Its button
    // scrolled out of sight, the menu closes: left where it was, it would hang over something else.
    let frame = 0;
    const follow = () => {
      if (!inSight(anchor, clips)) {
        close();
        return;
      }
      if (box.current) {
        const next = floatingPlace(anchor, box.current, placement);
        setPlace((was) => (was && was.top === next.top && was.left === next.left ? was : next));
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => {
      cancelAnimationFrame(frame);
      setPlace(null);
    };
  }, [open, floating, placement]);

  // In the menu's order of the page the keyboard would never reach a floating menu: it starts on its
  // first item — once the menu stands in its place: the browser does not focus a hidden element.
  const placed = place !== null;
  const focused = useRef(false);
  useEffect(() => {
    if (!open || !floating) {
      focused.current = false;
      return;
    }
    if (!placed || focused.current) return;
    focused.current = true;
    box.current?.querySelector<HTMLElement>('button')?.focus();
  }, [open, floating, placed]);

  if (!open) return null;
  if (!floating) {
    return (
      <div ref={box} role={role} aria-label={label} className={cx(styles.menu, styles[placement])} style={width ? { width } : undefined}>
        {children}
      </div>
    );
  }
  return (
    <>
      <span ref={spot} hidden />
      {createPortal(
        // Hidden until placed: the first frame is never drawn in the corner of the window.
        <div ref={box} role={role} aria-label={label} className={cx(styles.menu, styles.floating)} style={{ ...(width ? { width } : {}), ...(place ?? { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }) }}>
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

export function MenuTitle({ children }: { children: ReactNode }) {
  return <div className={styles.menuTitle}>{children}</div>;
}

// `accent` is an item that creates something («Новый проект»), set apart in the accent colour.
export function MenuItem({ icon, meta, onSelect, children, danger, accent, checked }: { icon?: IconName; meta?: ReactNode; onSelect: () => void; children: ReactNode; danger?: boolean; accent?: boolean; checked?: boolean }) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      className={cx(styles.menuItem, danger && styles.danger, accent && styles.accent)}
      onClick={onSelect}
    >
      {icon ? <Icon name={icon} size={15} className={danger || accent ? undefined : cx(styles.menuItemIcon, checked && styles.menuItemIconOn)} /> : null}
      <span className={styles.menuItemLabel}>{children}</span>
      {meta ? <span className={styles.menuItemMeta}>{meta}</span> : null}
      {checked ? <Icon name="check" size={15} style={{ color: 'var(--acc-text)' }} /> : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div className={styles.separator} />;
}
