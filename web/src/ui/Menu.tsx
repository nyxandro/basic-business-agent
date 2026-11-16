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
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // The keyboard went into a floating menu: it comes back to the button.
      if (floating && box.current?.contains(document.activeElement)) anchorOf()?.querySelector<HTMLElement>('button')?.focus();
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
    if (!open || !floating) return;
    const update = () => {
      const anchor = spot.current?.parentElement;
      if (anchor && box.current) setPlace(floatingPlace(anchor, box.current, placement));
    };
    update();
    // Away from the page's flow, the menu follows its button when anything scrolls or the window changes.
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      setPlace(null);
    };
  }, [open, floating, placement]);

  // In the menu's order of the page the keyboard would never reach a floating menu: it starts on its first item.
  useEffect(() => {
    if (open && floating) box.current?.querySelector<HTMLElement>('button')?.focus();
  }, [open, floating]);

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
