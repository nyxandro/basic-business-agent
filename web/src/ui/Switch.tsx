// An on/off switch (mockup): a track with a knob, role="switch" with the name of what it turns.
import { cx } from './Button.tsx';
import styles from './controls.module.css';

export function Switch({ checked, label, onChange, disabled, size = 'md' }: { checked: boolean; label: string; onChange: (next: boolean) => void; disabled?: boolean; size?: 'md' | 'lg' }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} disabled={disabled} className={cx(styles.switch, size === 'lg' && styles.switchLg)} onClick={() => onChange(!checked)}>
      <span className={styles.knob} />
    </button>
  );
}
