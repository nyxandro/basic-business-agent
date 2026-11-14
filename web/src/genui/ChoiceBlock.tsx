// Choice (spec, section 7): the answer leaves as an ordinary message, then the block is inactive.
import type { ChoiceBlock } from '@bba/contracts';

export function ChoiceBlockView({ block, answered, onAnswer }: { block: ChoiceBlock; answered: boolean; onAnswer: (text: string) => void }) {
  return (
    <div className="genui genui-choice">
      <p>{block.question}</p>
      <div className="genui-options">
        {block.options.map((o) => (
          <button key={o.value} type="button" className="btn secondary" disabled={answered} onClick={() => onAnswer(o.label)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
