import type { CardBlock } from '@bba/contracts';
import { Fragment } from 'react';
import styles from './genui.module.css';

export function CardBlockView({ block }: { block: CardBlock }) {
  return (
    <article className={`${styles.block} ${styles.card}`}>
      <h3 className={styles.cardTitle}>{block.title}</h3>
      {block.subtitle ? <p className={styles.cardSub}>{block.subtitle}</p> : null}
      {block.fields.length > 0 ? (
        <dl className={styles.fields}>
          {block.fields.map((f, i) => (
            <Fragment key={i}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </article>
  );
}
