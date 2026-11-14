import type { CardBlock } from '@bba/contracts';

export function CardBlockView({ block }: { block: CardBlock }) {
  return (
    <article className="genui genui-card">
      <h3>{block.title}</h3>
      {block.subtitle ? <p className="genui-subtitle">{block.subtitle}</p> : null}
      <dl>
        {block.fields.map((f, i) => (
          <div key={i} className="genui-field">
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}
