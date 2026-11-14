// The paperclip (spec, section 7): files go to the employee's working folder on the server, where
// the skills read them; the message then names them.
import { MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS } from '@bba/contracts';
import { useState, type RefObject } from 'react';
import { ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Spinner } from '../ui/Loading.tsx';
import { uploadFile } from './api.ts';
import { useChatExtras } from './chat-context.ts';

// The "+" button of the chat input opens `inputRef`; this bar shows what is attached.
export function AttachmentBar({ inputRef: input }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const extras = useChatExtras();
  const [busy, setBusy] = useState(false);

  async function upload(target: HTMLInputElement) {
    const file = target.files?.[0];
    // The same file can be chosen again after removing it.
    target.value = '';
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      extras.onUploadError(new ApiRequestError({ code: 'APP_UPLOAD_TOO_LARGE', message: ru.chat.tooLarge, status: 0 }));
      return;
    }
    setBusy(true);
    try {
      extras.addAttachment(await uploadFile(extras.threadId, file));
    } catch (error) {
      extras.onUploadError(error);
    } finally {
      setBusy(false);
    }
  }

  const empty = !busy && extras.attachments.length === 0;
  return (
    <div className={empty ? 'attachment-bar attachment-bar-empty' : 'attachment-bar'}>
      {busy ? (
        <span className="chip">
          <Spinner /> {ru.chat.uploading}
        </span>
      ) : null}
      <input ref={input} type="file" hidden accept={UPLOAD_EXTENSIONS.join(',')} aria-label={ru.chat.attach} onChange={(e) => void upload(e.currentTarget)} />
      {extras.attachments.map((f) => (
        <span key={f.path} className="chip">
          {f.name}
          <button type="button" className="link-button" aria-label={`${ru.chat.removeAttachment} ${f.name}`} onClick={() => extras.removeAttachment(f.path)}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
