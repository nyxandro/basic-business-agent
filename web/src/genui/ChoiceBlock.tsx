// Choice (spec, section 7): the answer leaves as an ordinary message, then the block is inactive.
// The option the person took stays set apart by colour and a tick (owner's list 16.11), also after
// the page is opened again; an answer in the person's own words marks none.
import type { ChoiceBlock } from '@bba/contracts';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import styles from './genui.module.css';

export function ChoiceBlockView({ block, answer, onAnswer }: { block: ChoiceBlock; answer: string | null; onAnswer: (text: string) => void }) {
  return (
    <div>
      <p className={styles.question}>{block.question}</p>
      <div className={styles.options}>
        {block.options.map((o) => {
          const chosen = answer !== null && answer === o.label.trim();
          return (
            <button key={o.value} type="button" className={cx(styles.option, chosen && styles.optionChosen)} disabled={answer !== null} data-chosen={chosen || undefined} onClick={() => onAnswer(o.label)}>
              {chosen ? <Icon name="check" size={15} /> : null}
              {o.label}
              {chosen ? <span className="visually-hidden">{ru.genui.chosen}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
