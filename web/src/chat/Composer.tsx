// The input (mockup): the text grows with what is typed; the paperclip adds files — several at once —
// to the working folder on the server (they go with the message as names; attach.ts); Enter sends, Shift+Enter breaks the
// line; while the agent answers the round button stops it. The microphone (when the installation
// has a recognition model) turns the input into the recording bar; the recognised text is added
// to the field, or to the draft of this conversation if the person has left it meanwhile.
import { UPLOAD_EXTENSIONS } from '@bba/contracts';
import { useCallback, useEffect, useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useMe } from '../auth/session.tsx';
import { ru } from '../i18n/ru.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import { canRecord } from '../voice/recorder.ts';
import { useVoice } from '../voice/use-voice.ts';
import { MicButton, RecordingBar, VoiceStatus } from '../voice/VoiceParts.tsx';
import { Attachments } from './Attachments.tsx';
import type { WaitingFile } from './attach.ts';
import type { UploadProgress } from './upload-progress.ts';
import { useChatExtras } from '../answer/chat-context.ts';
import { readDraft, writeDraft } from './drafts.ts';
import styles from './chat.module.css';

const MAX_HEIGHT = 220;
// A pasted text longer than this goes up as a file instead of into the field (request of the owner 25.11).
const PASTED_AS_FILE = 1000;

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

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  extra,
  uploading,
  progress,
  onAttach,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop?: () => void;
  running: boolean;
  extra?: ReactNode;
  // Files on their way up, and how far they are.
  uploading: readonly WaitingFile[];
  progress: UploadProgress;
  onAttach: (files: File[]) => void;
}) {
  const extras = useChatExtras();
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Words, or files alone — a pasted text needs no words of its own.
  const ready = (value.trim().length > 0 || extras.attachments.length > 0) && uploading.length === 0 && !extras.offline;
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

  // A long text pasted goes up as a file of its own, a chip like any attachment (request of the owner 25.11): the field
  // stays readable, and the agent reads it as an attachment (spec, section 8.29).
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const text = event.clipboardData.getData('text/plain');
    if (text.length <= PASTED_AS_FILE) return;
    event.preventDefault();
    onAttach([new File([text], ru.chat.pastedName(text.length), { type: 'text/plain' })]);
  }

  function pick(target: HTMLInputElement) {
    const files = [...(target.files ?? [])];
    // The same files can be chosen again after removing them.
    target.value = '';
    if (files.length > 0) onAttach(files);
  }

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (ready && !running) onSend();
  };

  if (voice.state.status === 'recording') return <RecordingBar seconds={voice.state.seconds} onCancel={voice.cancel} onDone={voice.finish} />;

  return (
    <div className={styles.composer}>
      <Attachments uploading={uploading} progress={progress} voice={voiceLine} />
      <textarea ref={area} className={styles.textarea} rows={2} value={value} placeholder={ru.chat.placeholder} aria-label={ru.chat.message} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} onPaste={paste} />
      <div className={styles.composerRow}>
        <input ref={fileInput} type="file" hidden multiple accept={UPLOAD_EXTENSIONS.join(',')} aria-label={ru.chat.attach} onChange={(e) => pick(e.currentTarget)} />
        <IconButton icon="clip" variant="outline" label={ru.chat.attach} onClick={() => fileInput.current?.click()} />
        {extra}
        <span className={styles.fill} />
        {me.voiceAvailable ? <MicButton supported={canRecord()} busy={voice.state.status === 'starting' || voice.state.status === 'transcribing'} onClick={voice.start} /> : null}
        {running && onStop ? (
          <button type="button" className={cx(styles.send, styles.sendReady)} aria-label={ru.chat.stop} title={ru.chat.stop} onClick={onStop}>
            <Icon name="stop" size={18} />
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
