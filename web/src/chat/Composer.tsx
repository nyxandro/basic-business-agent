// The input (mockup): the text grows with what is typed; the paperclip adds files to the working
// folder on the server (they go with the message as names); Enter sends, Shift+Enter breaks the
// line; while the agent answers the round button stops it.
import { MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS } from '@bba/contracts';
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import { uploadFile } from './api.ts';
import { useChatExtras } from './chat-context.ts';
import styles from './chat.module.css';

const MAX_HEIGHT = 220;

function Attachments({ uploading }: { uploading: string | null }) {
  const extras = useChatExtras();
  if (!uploading && extras.attachments.length === 0) return null;
  return (
    <div className={styles.chips}>
      {extras.attachments.map((f) => (
        <span key={f.path} className={styles.chip}>
          <Icon name="file" size={15} />
          <span className={styles.chipName}>{f.name}</span>
          <IconButton icon="x" size="sm" label={`${ru.chat.removeAttachment} ${f.name}`} onClick={() => extras.removeAttachment(f.path)} />
        </span>
      ))}
      {uploading ? (
        <span className={styles.chip} role="status">
          <span className={styles.spin} />
          <span className={styles.chipName}>{uploading}</span>
        </span>
      ) : null}
    </div>
  );
}

export function Composer({ value, onChange, onSend, onStop, running, extra }: { value: string; onChange: (v: string) => void; onSend: () => void; onStop?: () => void; running: boolean; extra?: ReactNode }) {
  const extras = useChatExtras();
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const ready = value.trim().length > 0 && !uploading;

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  async function upload(target: HTMLInputElement) {
    const file = target.files?.[0];
    // The same file can be chosen again after removing it.
    target.value = '';
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      extras.onUploadError(new ApiRequestError({ code: 'APP_UPLOAD_TOO_LARGE', message: ru.chat.tooLarge, status: 0 }));
      return;
    }
    setUploading(file.name);
    try {
      extras.addAttachment(await uploadFile(extras.threadId, file));
    } catch (error) {
      extras.onUploadError(error);
    } finally {
      setUploading(null);
    }
  }

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (ready && !running) onSend();
  };

  return (
    <div className={styles.composer}>
      <Attachments uploading={uploading ? ru.chat.uploadingName(uploading) : null} />
      <textarea ref={area} className={styles.textarea} rows={2} value={value} placeholder={ru.chat.placeholder} aria-label={ru.chat.message} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} />
      <div className={styles.composerRow}>
        <input ref={fileInput} type="file" hidden accept={UPLOAD_EXTENSIONS.join(',')} aria-label={ru.chat.attach} onChange={(e) => void upload(e.currentTarget)} />
        <IconButton icon="clip" variant="outline" label={ru.chat.attach} onClick={() => fileInput.current?.click()} disabled={Boolean(uploading)} />
        {extra}
        <span className={styles.fill} />
        {running && onStop ? (
          <button type="button" className={cx(styles.send, styles.sendReady)} aria-label={ru.chat.stop} title={ru.chat.stop} onClick={onStop}>
            <Icon name="stop" size={16} />
          </button>
        ) : (
          <button type="button" className={cx(styles.send, ready && styles.sendReady)} aria-label={ru.chat.send} title={ru.chat.send} disabled={!ready || running} onClick={onSend}>
            <Icon name="up" />
          </button>
        )}
      </div>
    </div>
  );
}
