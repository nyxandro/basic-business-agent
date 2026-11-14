// The input (mockup): the text grows with what is typed; the paperclip adds files to the working
// folder on the server (they go with the message as names); Enter sends, Shift+Enter breaks the
// line; while the agent answers the round button stops it. The microphone (when the installation
// has a recognition model) turns the input into the recording bar; the recognised text is added
// to the field, or to the draft of this conversation if the person has left it meanwhile.
import { MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS } from '@bba/contracts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ApiRequestError } from '../api/client.ts';
import { useMe } from '../auth/session.tsx';
import { ru } from '../i18n/ru.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import { canRecord } from '../voice/recorder.ts';
import { useVoice } from '../voice/use-voice.ts';
import { MicButton, RecordingBar, VoiceStatus } from '../voice/VoiceParts.tsx';
import { uploadFile } from './api.ts';
import { useChatExtras } from './chat-context.ts';
import { readDraft, writeDraft } from './drafts.ts';
import styles from './chat.module.css';

const MAX_HEIGHT = 220;

const appendText = (current: string, text: string) => (current.trim() ? `${current.trimEnd()} ${text}` : text);

const DRAFT_CHANGED = 'bba:draft-changed';
interface DraftChange {
  agentId: string;
  threadId: string;
}

// A field of a conversation follows its draft changed from outside (recognised voice).
function useDraftChanges(agentId: string, threadId: string, onChange: (v: string) => void): void {
  const latest = useRef(onChange);
  useLayoutEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    const listener = (event: Event) => {
      const { detail } = event as CustomEvent<DraftChange>;
      if (detail.agentId === agentId && detail.threadId === threadId) latest.current(readDraft(agentId, threadId));
    };
    window.addEventListener(DRAFT_CHANGED, listener);
    return () => window.removeEventListener(DRAFT_CHANGED, listener);
  }, [agentId, threadId]);
}

// Where recognised text goes: the field while the conversation is open, its draft after that.
function useDeliverText(agentId: string, threadId: string, value: string, onChange: (v: string) => void): (text: string) => void {
  const latest = useRef({ value, onChange, open: true });
  useLayoutEffect(() => {
    latest.current = { value, onChange, open: true };
  });
  useEffect(
    () => () => {
      latest.current.open = false;
    },
    [],
  );
  return useCallback(
    (text: string) => {
      const now = latest.current;
      if (now.open) return now.onChange(appendText(now.value, text));
      writeDraft(agentId, threadId, appendText(readDraft(agentId, threadId), text));
      // The person may be back in this conversation already: its new field takes the draft.
      window.dispatchEvent(new CustomEvent<DraftChange>(DRAFT_CHANGED, { detail: { agentId, threadId } }));
    },
    [agentId, threadId],
  );
}

function Attachments({ uploading, voice }: { uploading: string | null; voice: ReactNode }) {
  const extras = useChatExtras();
  if (!uploading && extras.attachments.length === 0 && !voice) return null;
  return (
    <div className={styles.chips}>
      {voice}
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
  const me = useMe();
  const deliver = useDeliverText(extras.agentId, extras.threadId, value, onChange);
  useDraftChanges(extras.agentId, extras.threadId, onChange);
  const voice = useVoice(extras.agentId, deliver);
  const voiceLine = voice.state.status === 'transcribing' || voice.state.status === 'failed' ? <VoiceStatus state={voice.state} onRetry={voice.retry} onDismiss={voice.dismiss} /> : null;

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

  if (voice.state.status === 'recording') return <RecordingBar seconds={voice.state.seconds} onCancel={voice.cancel} onDone={voice.finish} />;

  return (
    <div className={styles.composer}>
      <Attachments uploading={uploading ? ru.chat.uploadingName(uploading) : null} voice={voiceLine} />
      <textarea ref={area} className={styles.textarea} rows={2} value={value} placeholder={ru.chat.placeholder} aria-label={ru.chat.message} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} />
      <div className={styles.composerRow}>
        <input ref={fileInput} type="file" hidden accept={UPLOAD_EXTENSIONS.join(',')} aria-label={ru.chat.attach} onChange={(e) => void upload(e.currentTarget)} />
        <IconButton icon="clip" variant="outline" label={ru.chat.attach} onClick={() => fileInput.current?.click()} disabled={Boolean(uploading)} />
        {extra}
        <span className={styles.fill} />
        {me.voiceAvailable ? <MicButton supported={canRecord()} busy={voice.state.status === 'starting' || voice.state.status === 'transcribing'} onClick={voice.start} /> : null}
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
