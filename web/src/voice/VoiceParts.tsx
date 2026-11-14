// The pieces of voice input in the composer (mockup): the microphone button, the recording bar
// (dot, time, wave, «Отменить запись», «Готово») with the warning about the outside service, and
// the line of «Распознаю…» or of a failure with «Повторить распознавание».
import { ru } from '../i18n/ru.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import type { VoiceState } from './use-voice.ts';
import styles from './voice.module.css';

// Heights and timings of the wave: a fixed pattern, it only shows that recording goes on.
const WAVE = Array.from({ length: 40 }, (_, i) => ({
  height: 10 + Math.round(26 * Math.abs(Math.sin(i * 0.9) * Math.cos(i * 0.37))),
  delay: `${((i * 0.07) % 1).toFixed(2)}s`,
  duration: `${(0.8 + (i % 5) * 0.12).toFixed(2)}s`,
}));

export function MicButton({ supported, busy, onClick }: { supported: boolean; busy: boolean; onClick: () => void }) {
  return <IconButton icon="mic" label={ru.voice.mic} title={supported ? ru.voice.hint : ru.voice.needsHttps} disabled={!supported || busy} onClick={onClick} round />;
}

export function RecordingBar({ seconds, onCancel, onDone }: { seconds: number; onCancel: () => void; onDone: () => void }) {
  return (
    <>
      <div className={styles.bar}>
        <span className={styles.dot} />
        <span className={styles.time}>{ru.voice.time(seconds)}</span>
        <div className={styles.wave} aria-hidden="true">
          {WAVE.map((w, i) => (
            <span key={i} className={styles.waveBar} style={{ height: w.height, animationDelay: w.delay, animationDuration: w.duration }} />
          ))}
        </div>
        <IconButton icon="x" label={ru.voice.cancel} variant="outline" round className={styles.cancel} onClick={onCancel} />
        <button type="button" className={styles.done} aria-label={ru.voice.done} title={ru.voice.done} onClick={onDone}>
          <Icon name="check" />
        </button>
      </div>
      <p className={styles.hint}>{ru.voice.hint}</p>
    </>
  );
}

export function VoiceStatus({ state, onRetry, onDismiss }: { state: VoiceState; onRetry: () => void; onDismiss: () => void }) {
  if (state.status === 'transcribing') {
    return (
      <span className={styles.status} role="status">
        <span className={styles.spin} />
        <span className={styles.shimmer}>{ru.voice.recognising}</span>
      </span>
    );
  }
  if (state.status !== 'failed') return null;
  return (
    <span className={cx(styles.status, styles.failed)} role="alert">
      <Icon name="alert" size={15} />
      <span className={styles.statusText}>
        {state.error.message}
        <span className={styles.code}> · {state.error.code}</span>
      </span>
      {state.audio ? (
        <button type="button" className={styles.retry} onClick={onRetry}>
          {ru.voice.retry}
        </button>
      ) : null}
      <IconButton icon="x" size="sm" label={ru.voice.dismiss} onClick={onDismiss} />
    </span>
  );
}
