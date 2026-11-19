// A message of the person: a bubble on the right, the files it brought above it — the same chips as above
// the input, on the page and not in the bubble: on the bubble's fill a chip was lost (request of the owner 19.11).
import { FileIcon } from '../ui/FileIcon.tsx';
import { cx } from '../ui/Button.tsx';
import attachments from './attachments.module.css';
import styles from './chat.module.css';
import { splitAttachments } from '@bba/contracts';
import { StillFileName } from './FileName.tsx';
import { textOf } from './messages.ts';

export function UserMessage({ content }: { content: unknown }) {
  const { text, files } = splitAttachments(textOf(content));
  return (
    <div className={styles.userTurn}>
      {files.length > 0 ? (
        <div className={styles.userFiles}>
          {files.map(({ name, path }) => (
            <span key={path} className={cx(attachments.chip, attachments.chipSent)}>
              <FileIcon name={name} />
              <StillFileName name={name} />
            </span>
          ))}
        </div>
      ) : null}
      <div className={styles.user}>{text}</div>
    </div>
  );
}
