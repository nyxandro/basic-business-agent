// Buttons of the mock-up. The look is one explicit variant, not a set of flags.
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './button.module.css';
import { Icon, type IconName } from './Icon.tsx';

type Size = 'sm' | 'md' | 'lg';

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
  size?: Size;
  icon?: IconName;
  block?: boolean;
  children: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', icon, block, className, type = 'button', children, ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx(styles.button, styles[variant], size !== 'md' && styles[size], block && styles.block, className)} {...rest}>
      {icon ? <Icon name={icon} size={size === 'sm' ? 14 : 15} /> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string;
  icon: IconName;
  variant?: 'ghost' | 'outline' | 'primary' | 'soft' | 'muted';
  size?: Size;
  round?: boolean;
  iconSize?: number;
}

// An icon without a word: the label is what a screen reader says and what the tooltip shows.
export function IconButton({ label, icon, variant = 'ghost', size = 'md', round, iconSize, className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(styles.button, styles.icon, styles[variant === 'ghost' ? 'plain' : variant], size !== 'md' && styles[size], round && styles.round, className)}
      {...rest}
    >
      <Icon name={icon} size={iconSize ?? (size === 'lg' ? 20 : 18)} />
    </button>
  );
}
