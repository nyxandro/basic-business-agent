// Choice (spec, section 7): the answer leaves as an ordinary message, then the block is inactive.
import type { ChoiceBlock } from '@bba/contracts';
import styles from './genui.module.css';

export function ChoiceBlockView({ block, answered, onAnswer }: { block: ChoiceBlock; answered: boolean; onAnswer: (text: string) => void }) {
  return (
    <div>
      <p className={styles.question}>{block.question}</p>
      <div className={styles.options}>
        {block.options.map((o) => (
          <button key={o.value} type="button" className={styles.option} disabled={answered} onClick={() => onAnswer(o.label)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
