// A message of the person: one bubble on the right, the files it brought at its top, above the words (request
// of the owner 19.11) — the chips of the input, on the fill of the page: on the bubble's own fill they were lost. The
// marks of a document sent from the viewer are one block that unfolds (MarksMessage.tsx).
import { useContext } from 'react';
import { FileIcon } from '../ui/FileIcon.tsx';
import { cx } from '../ui/Button.tsx';
import attachments from './attachments.module.css';
import styles from './chat.module.css';
import { splitAttachments, splitPasted } from '@bba/contracts';
import { ChatExtrasContext } from '../answer/chat-context.ts';
import { StillFileName } from './FileName.tsx';
import { peekOf, useImagePeek } from './image-peek.tsx';
import { textOf } from '../answer/messages.ts';
import { readMarksMessage } from '../viewer/marks/message.ts';
import { MarksMessage } from './MarksMessage.tsx';
import { PastedText } from './PastedText.tsx';

export function UserMessage({ content }: { content: unknown }) {
  const { text, files } = splitAttachments(textOf(content));
  const marks = readMarksMessage(text);
  return marks ? <MarksMessage data={marks} files={files} /> : <PlainMessage text={text} files={files} />;
}

function PlainMessage({ text: message, files }: { text: string; files: ReturnType<typeof splitAttachments>['files'] }) {
  // A chip of a picture shows it on hovering (image-peek.tsx); outside a conversation there is nothing to read.
  const { bind, peek } = useImagePeek(useContext(ChatExtrasContext)?.threadId ?? null);
  // Long texts pasted into the input: folded, below the files and above the words (request of the owner 25.11).
  const { text, pieces } = splitPasted(message);
  return (
    <div className={styles.user}>
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
      {pieces.length > 0 ? (
        <div className={styles.userPasted}>
          {pieces.map((piece, i) => (
            <PastedText key={i} text={piece} />
          ))}
        </div>
      ) : null}
      {text}
    </div>
  );
}
