// A message of the person (mockup): a bubble on the right, the files it brought as chips under it.
import { Icon } from '../ui/Icon.tsx';
import styles from './chat.module.css';
import { splitAttachments } from '@bba/contracts';
import { textOf } from './messages.ts';

export function UserMessage({ content }: { content: unknown }) {
  const { text, files } = splitAttachments(textOf(content));
  return (
    <div className={styles.user}>
      {text}
      {files.length > 0 ? (
        <div className={styles.userFiles}>
          {files.map(({ name }) => (
            <span key={name} className={styles.chip}>
              <Icon name="file" size={15} />
              <span className={styles.chipName}>{name}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
