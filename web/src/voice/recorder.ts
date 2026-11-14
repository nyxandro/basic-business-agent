// A recording from the microphone (spec, section 8.14): MediaRecorder in the format the browser
// writes (Chrome and Firefox — webm, Safari — mp4). The microphone is released when it ends.
import { ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';

export interface Recording {
  // The whole recording and how long it ran.
  finish: () => Promise<{ audio: Blob; ms: number }>;
  cancel: () => void;
}

// Recording works on https and localhost only, and needs MediaRecorder.
export function canRecord(): boolean {
  return window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined';
}

export async function startRecording(): Promise<Recording> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    throw new ApiRequestError({ code: 'APP_VOICE_NO_MIC', message: ru.voice.noMic, status: 0, cause: error });
  }
  const release = () => stream.getTracks().forEach((track) => track.stop());
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream);
    recorder.start();
  } catch (error) {
    // The microphone is already taken: give it back, or its light stays on until a reload.
    release();
    throw new ApiRequestError({ code: 'APP_VOICE_RECORDER_FAILED', message: ru.voice.recorderFailed, status: 0, cause: error });
  }
  const parts: Blob[] = [];
  const startedAt = Date.now();
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) parts.push(e.data);
  };
  return {
    finish: () =>
      new Promise((resolve) => {
        const ms = Date.now() - startedAt;
        recorder.onstop = () => {
          release();
          resolve({ audio: new Blob(parts, { type: recorder.mimeType }), ms });
        };
        recorder.stop();
      }),
    cancel: () => {
      recorder.onstop = release;
      if (recorder.state !== 'inactive') recorder.stop();
      else release();
    },
  };
}
