// Small display pieces of the mock-up: cards, pills, avatars, icon tiles, progress, empty states,
// page headings. Variants are explicit values, not flags.
import type { CSSProperties, ReactNode } from 'react';
import { cx } from './Button.tsx';
import styles from './display.module.css';
import { Icon, type IconName } from './Icon.tsx';

// `label` names a card that is a section of its own page (a region for screen readers).
export function Card({ children, padded, lift, className, style, as: Tag = 'div', label }: { children: ReactNode; padded?: boolean; lift?: boolean; className?: string; style?: CSSProperties; as?: 'div' | 'section' | 'li'; label?: string }) {
  return (
    <Tag className={cx(styles.card, padded && styles.padded, lift && styles.lift, className)} style={style} aria-label={label}>
      {children}
    </Tag>
  );
}

export function CardHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={styles.cardHead}>
      <div className={styles.cardTitle}>
        {title}
        {sub ? <div className={styles.cardSub}>{sub}</div> : null}
      </div>
      {actions}
    </div>
  );
}

export function CardFoot({ children }: { children: ReactNode }) {
  return <div className={styles.cardFoot}>{children}</div>;
}

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad';

export function Pill({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cx(styles.pill, styles[tone], className)}>{children}</span>;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

export function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  return (
    <span className={styles.avatar} style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function IconTile({ icon, size = 36, solid, className }: { icon: IconName; size?: number; solid?: boolean; className?: string }) {
  return (
    <span className={cx(styles.badge, solid && styles.badgeSolid, className)} style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}>
      <Icon name={icon} size={Math.round(size * 0.48)} />
    </span>
  );
}

// value is a share from 0 to 1; label is what a screen reader says.
export function Progress({ value, label, tone = 'accent', height = 6 }: { value: number; label: string; tone?: 'accent' | 'warn' | 'bad'; height?: number }) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className={styles.track} style={{ height }} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <div className={cx(styles.bar, tone === 'warn' && styles.barWarn, tone === 'bad' && styles.barBad)} style={{ width: `${percent}%` }} />
    </div>
  );
}

export function EmptyState({ title, text, action }: { title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyTitle}>{title}</div>
      {text ? <div className={styles.emptyText}>{text}</div> : null}
      {action ? <div className={styles.emptyAction}>{action}</div> : null}
    </div>
  );
}

export function PageHead({ title, lead, actions }: { title: string; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={cx(styles.pageHead, 'rise')}>
      <div className={styles.pageText}>
        <h1 className={styles.pageTitle}>{title}</h1>
        {lead ? <p className={styles.pageLead}>{lead}</p> : null}
      </div>
      {actions}
    </div>
  );
}

export function GroupLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className={styles.groupLabel} style={style}>
      {children}
    </div>
  );
}
