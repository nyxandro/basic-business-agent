// Voice input of one conversation: record → «Готово» (or 120 s) → «Распознаю…» → the text is
// handed to `deliver`. A failed recognition keeps the recording for «Повторить распознавание».
// Recognition goes on after the person leaves the conversation: `deliver` decides where the text
// goes. The recording itself is never stored.
import { useCallback, useEffect, useRef, useState } from 'react';
import { asApiError, ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { transcribe } from './api.ts';
import { startRecording, type Recording } from './recorder.ts';

export const RECORD_LIMIT_S = 120;
// Shorter than this is a slip of the finger, not speech.
const MIN_RECORD_MS = 500;
const TICK_MS = 1000;

export type VoiceState =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'recording'; seconds: number }
  | { status: 'transcribing' }
  | { status: 'failed'; error: ApiRequestError; audio: Blob | null };

export function useVoice(agentId: string, deliver: (text: string) => void): { state: VoiceState; start: () => void; finish: () => void; cancel: () => void; retry: () => void; dismiss: () => void } {
  const [state, setState] = useState<VoiceState>({ status: 'idle' });
  const recording = useRef<Recording | null>(null);
  const mounted = useRef(true);
  const update = (next: VoiceState) => mounted.current && setState(next);

  const recognise = useCallback(
    (audio: Blob) => {
      update({ status: 'transcribing' });
      transcribe(audio, agentId).then(
        ({ text }) => {
          update({ status: 'idle' });
          deliver(text);
        },
        (raw: unknown) => update({ status: 'failed', error: asApiError(raw), audio }),
      );
    },
    [agentId, deliver],
  );

  const finish = useCallback(() => {
    const current = recording.current;
    if (!current) return;
    recording.current = null;
    // The bar goes away at once; the browser hands the recording over a moment later.
    setState({ status: 'transcribing' });
    void current.finish().then(({ audio, ms }) => {
      if (ms < MIN_RECORD_MS) update({ status: 'failed', error: new ApiRequestError({ code: 'APP_VOICE_TOO_SHORT', message: ru.voice.tooShort, status: 0 }), audio: null });
      else recognise(audio);
    });
  }, [recognise]);

  const start = useCallback(() => {
    setState({ status: 'starting' });
    startRecording().then(
      (r) => {
        if (!mounted.current) return r.cancel();
        recording.current = r;
        setState({ status: 'recording', seconds: 0 });
      },
      (raw: unknown) => update({ status: 'failed', error: asApiError(raw), audio: null }),
    );
  }, []);

  const cancel = useCallback(() => {
    recording.current?.cancel();
    recording.current = null;
    setState({ status: 'idle' });
  }, []);

  // The clock of the recording bar, and the stop at the limit.
  const recordingNow = state.status === 'recording';
  useEffect(() => {
    if (!recordingNow) return;
    const timer = setInterval(() => setState((s) => (s.status === 'recording' ? { status: 'recording', seconds: s.seconds + 1 } : s)), TICK_MS);
    return () => clearInterval(timer);
  }, [recordingNow]);
  useEffect(() => {
    if (state.status === 'recording' && state.seconds >= RECORD_LIMIT_S) finish();
  }, [state, finish]);

  // Leaving the conversation drops an unfinished recording and frees the microphone.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recording.current?.cancel();
      recording.current = null;
    };
  }, []);

  const retry = () => {
    if (state.status === 'failed' && state.audio) recognise(state.audio);
  };
  return { state, start, finish, cancel, retry, dismiss: () => setState({ status: 'idle' }) };
}
