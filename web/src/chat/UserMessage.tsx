// A message of the person: one bubble on the right, the files it brought at its top, above the words (request
// of the owner 19.11) — the chips of the input, on the fill of the page: on the bubble's own fill they were lost.
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
    <div className={styles.user}>
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
      {text}
    </div>
  );
}
