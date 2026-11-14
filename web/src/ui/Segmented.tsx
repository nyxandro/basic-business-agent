// A few exclusive choices side by side (the theme in settings): a radio group, not toggles.
import styles from './controls.module.css';
import { Icon, type IconName } from './Icon.tsx';

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
  icon?: IconName;
}

export function Segmented<V extends string>({ label, options, value, onChange }: { label: string; options: SegmentOption<V>[]; value: V; onChange: (next: V) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className={styles.segmented}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={styles.segment} onClick={() => onChange(o.value)}>
          {o.icon ? <Icon name={o.icon} size={15} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}
