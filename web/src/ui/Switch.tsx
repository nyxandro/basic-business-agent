import styles from './controls.module.css';

export function Switch({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={styles.switch} onClick={() => onChange(!checked)}>
      <span className={styles.knob} />
    </button>
  );
}
