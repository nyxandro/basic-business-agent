// Files attached to the next message (spec, section 8.9): several at once — from the paperclip or
// dragged onto the chat window. They go up one at a time, in the order given, so the server never
// writes two files of one name at once and the chips fill in order. A file that cannot go (format,
// size, a folder) is not sent; the files that did not go are named in one error above the input,
// the others are attached.
import { MAX_UPLOAD_BYTES, UPLOAD_EXTENSIONS } from '@bba/contracts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiRequestError, asApiError, SESSION_EXPIRED } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { uploadFile } from './api.ts';
import { useChatExtras } from './chat-context.ts';
import { UploadProgress } from './upload-progress.ts';

export interface AttachFailure {
  name: string;
  error: ApiRequestError;
}

const EXTENSIONS: ReadonlySet<string> = new Set(UPLOAD_EXTENSIONS);
const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
};
const refusal = (code: string, message: string) => new ApiRequestError({ code, message, status: 0 });

// Why a file cannot be attached before it is sent, or null; the server checks the same again.
function refusalOf(file: File): ApiRequestError | null {
  if (!EXTENSIONS.has(extensionOf(file.name))) return refusal('APP_UPLOAD_TYPE_UNSUPPORTED', ru.chat.typeUnsupported);
  if (file.size > MAX_UPLOAD_BYTES) return refusal('APP_UPLOAD_TOO_LARGE', ru.chat.tooLarge);
  return null;
}

export const folderRefusal = (name: string): AttachFailure => ({ name, error: refusal('APP_UPLOAD_TYPE_UNSUPPORTED', ru.chat.folderNotAttached) });

// One error for the files that did not go: their names, and why — once for files of one reason.
export function attachFailure(failures: readonly AttachFailure[]): ApiRequestError {
  const reasons = new Map<string, string[]>();
  for (const f of failures) reasons.set(f.error.message, [...(reasons.get(f.error.message) ?? []), `«${f.name}»`]);
  const codes = [...new Set(failures.map((f) => f.error.code))].join(', ');
  const names = failures.map((f) => `«${f.name}»`).join(', ');
  if (reasons.size === 1) {
    const [reason] = reasons.keys();
    return refusal(codes, `${failures.length === 1 ? ru.chat.notAttachedOne : ru.chat.notAttachedMany} ${names}. ${reason}`);
  }
  const each = [...reasons].map(([reason, files]) => `${files.join(', ')} — ${reason}`).join(' ');
  return refusal(codes, `${ru.chat.notAttachedCount(failures.length)} ${each}`);
}

export interface WaitingFile {
  // Given once, when the file joins the queue: its chip stays the same chip while others go up.
  id: number;
  name: string;
}

export interface AttachQueue {
  // The files waiting or going up, in order.
  waiting: WaitingFile[];
  // Files to attach; `refused` — what was refused before (a dropped folder), named with the rest.
  attach: (files: readonly File[], refused?: readonly AttachFailure[]) => void;
  // How far each of them is, and the batch (upload-progress.ts).
  progress: UploadProgress;
}

export function useAttachQueue(): AttachQueue {
  const extras = useChatExtras();
  const latest = useRef(extras);
  useLayoutEffect(() => {
    latest.current = extras;
  });
  const queue = useRef<{ id: number; file: File }[]>([]);
  const nextId = useRef(0);
  const busy = useRef(false);
  // The failures of the files given since the queue was last empty: the error names them all.
  const failures = useRef<AttachFailure[]>([]);
  const open = useRef(true);
  const [waiting, setWaiting] = useState<WaitingFile[]>([]);
  const [progress] = useState(() => new UploadProgress());

  // A conversation left: the files not yet sent are not sent into it.
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  const show = () => setWaiting(queue.current.map(({ id, file }) => ({ id, name: file.name })));
  const fail = (added: readonly AttachFailure[]) => {
    if (added.length === 0) return;
    failures.current.push(...added);
    latest.current.onUploadError(attachFailure(failures.current));
  };

  // Everything below reads the queue through refs: a closure of an earlier render works the same.
  async function drain() {
    if (busy.current) return;
    busy.current = true;
    try {
      while (open.current && queue.current.length > 0) {
        const { id, file } = queue.current[0]!;
        try {
          // The request is the file and a little of the form around it: its share is the file's.
          latest.current.addAttachment(await uploadFile(latest.current.threadId, file, (sent, total) => progress.sent(id, (file.size * sent) / total)));
        } catch (raw) {
          const error = asApiError(raw);
          // Signed out: the rest would fail the same, and the error is the sign-in one as it is.
          if (error.code === SESSION_EXPIRED) {
            queue.current = [];
            progress.begin();
            latest.current.onUploadError(error);
            break;
          }
          fail([{ name: file.name, error }]);
        }
        progress.finish(id);
        queue.current.shift();
        if (open.current) show();
      }
    } finally {
      busy.current = false;
      if (open.current) show();
    }
  }

  function attach(files: readonly File[], refused: readonly AttachFailure[] = []) {
    if (!busy.current && queue.current.length === 0) {
      failures.current = [];
      progress.begin();
    }
    const failed = [...refused];
    for (const file of files) {
      const error = refusalOf(file);
      if (error) failed.push({ name: file.name, error });
      else {
        const id = nextId.current++;
        queue.current.push({ id, file });
        progress.add(id, file.size);
      }
    }
    fail(failed);
    show();
    void drain();
  }

  return { waiting, attach, progress };
}
