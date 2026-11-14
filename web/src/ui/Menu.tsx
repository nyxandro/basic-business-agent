// A small popover menu next to its button (settings, project of the conversation, row actions).
// It closes on a click outside and on Esc; the parent owns the open state.
import { useEffect, useEffectEvent, useRef, type ReactNode } from 'react';
import { cx } from './Button.tsx';
import { Icon, type IconName } from './Icon.tsx';
import styles from './overlay.module.css';

type Placement = 'top-start' | 'top-stretch' | 'bottom-end' | 'bottom-start';

export function MenuAnchor({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(styles.anchor, className)}>{children}</div>;
}

export function Menu({ open, onClose, label, placement = 'bottom-end', children, role = 'menu', width }: { open: boolean; onClose: () => void; label: string; placement?: Placement; children: ReactNode; role?: 'menu' | 'dialog'; width?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const close = useEffectEvent(onClose);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const anchor = box.current?.parentElement;
      if (anchor && !anchor.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div ref={box} role={role} aria-label={label} className={cx(styles.menu, styles[placement])} style={width ? { width } : undefined}>
      {children}
    </div>
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
