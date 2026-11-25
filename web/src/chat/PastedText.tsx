// A long text pasted into the input (request of the owner 25.11): folded into a block «Вставленный текст · 1 230 знаков»
// in the input and in the bubble; unfolded, the text itself. In the input it can be taken out. It goes as a part of the
// message (contracts/src/pasted.ts), no file.
import { useId, useState } from 'react';
import { ru } from '../i18n/ru.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import styles from './pasted-text.module.css';

export function PastedText({ text, onRemove }: { text: string; onRemove?: () => void }) {
  const [open, setOpen] = useState(false);
  const body = useId();
  return (
    <div className={styles.block}>
      <div className={styles.head}>
        <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={body} onClick={() => setOpen((o) => !o)}>
          <Icon name="file" size={15} className={styles.icon} />
          <span className={styles.label}>{ru.chat.pasted(text.length)}</span>
          <Icon name="down" size={13} className={cx(styles.chevron, open && styles.chevronOpen)} />
        </button>
        {onRemove ? <IconButton icon="x" size="sm" label={ru.chat.pastedRemove} className={styles.remove} onClick={onRemove} /> : null}
      </div>
      {open ? (
        <div id={body} className={cx(styles.text, 'scroll-thin')}>
          {text}
        </div>
      ) : null}
    </div>
  );
}
