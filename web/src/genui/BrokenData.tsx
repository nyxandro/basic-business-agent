// A block whose data does not fit the catalog (spec, section 7): the message and the data as text,
// so nothing the agent sent is lost — e.g. data saved by an older version of a block.
import { ru } from '../i18n/ru.ts';
import styles from './genui.module.css';

export function BrokenData({ data }: { data: unknown }) {
  return (
    <div className={styles.broken} role="alert">
      <p>{ru.genui.broken}</p>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}
