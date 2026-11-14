// A labelled form control: the label wraps the control, so a click on the words focuses it.
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cx } from './Button.tsx';
import styles from './controls.module.css';
import { Icon } from './Icon.tsx';

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cx(styles.field, className)}>
      {label}
      {children}
      {hint ? <span className={styles.hint}>{hint}</span> : null}
      {error ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function Input({ className, mono, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input className={cx(styles.input, mono && styles.mono, className)} {...rest} />;
}

export function TextArea({ className, mono, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea className={cx(styles.input, styles.textarea, mono && styles.mono, className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(styles.input, className)} {...rest} />;
}

// A search box with the magnifier inside; the label is only for screen readers.
export function SearchInput({ label, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = useId();
  return (
    <span className={className} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <label htmlFor={id} className="visually-hidden">
        {label}
      </label>
      <Icon name="search" size={15} style={{ position: 'absolute', left: 12, color: 'var(--muted)' }} />
      <input id={id} type="search" className={styles.input} style={{ paddingLeft: 36 }} {...rest} />
    </span>
  );
}
