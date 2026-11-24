// A message of the marks of a document in the chat (spec, section 8.32; request of the owner 25.11): the viewer sends the
// marks as an ordinary message — the agent needs its whole text and both files — but the bubble shows one block «Правки к
// документу «…» · 3 пометки»; unfolded, the document, the picture of the marks and the lines of the marks.
import type { AttachedFile } from '@bba/contracts';
import { useContext, useId, useState } from 'react';
import { ChatExtrasContext } from '../answer/chat-context.ts';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { FileIcon } from '../ui/FileIcon.tsx';
import { Icon } from '../ui/Icon.tsx';
import type { MarksMessageData } from '../viewer/marks/message.ts';
import attachments from './attachments.module.css';
import styles from './chat.module.css';
import { StillFileName } from './FileName.tsx';
import { peekOf, useImagePeek } from './image-peek.tsx';
import marks from './marks-message.module.css';

export function MarksMessage({ data, files }: { data: MarksMessageData; files: readonly AttachedFile[] }) {
  const [open, setOpen] = useState(false);
  const details = useId();
  // A chip of a picture shows it on hovering (image-peek.tsx); outside a conversation there is nothing to read.
  const { bind, peek } = useImagePeek(useContext(ChatExtrasContext)?.threadId ?? null);
  const title = ru.marks.bubble(data.kind, data.name, data.count);
  return (
    <div className={cx(styles.user, marks.bubble)}>
      <button type="button" className={marks.toggle} aria-expanded={open} aria-controls={details} onClick={() => setOpen((o) => !o)}>
        <Icon name="markup" size={16} className={marks.icon} />
        <span className={marks.title}>{title}</span>
        <Icon name="down" size={14} className={cx(marks.chevron, open && marks.chevronOpen)} />
      </button>
      {open ? (
        <div id={details} role="region" aria-label={title} className={marks.details}>
          {files.length > 0 ? (
            <div className={styles.userFiles} {...bind}>
              {peek}
              {files.map(({ name, path }) => (
                <span key={path} className={cx(attachments.chip, attachments.chipSent)} {...peekOf(name, path)}>
                  <FileIcon name={name} />
                  <StillFileName name={name} />
                </span>
              ))}
            </div>
          ) : null}
          <div className={marks.lines}>{data.lines.join('\n')}</div>
        </div>
      ) : null}
    </div>
  );
}
