// A ring that fills as a file goes up (spec, section 8.9; the owner, 17.11: the spinner told nothing):
// on the chip of each file, and one for the whole batch on the card of many files with its percent. Each
// ring listens to the progress itself (upload-progress.ts), so only it is drawn anew as bytes go.
import { useSyncExternalStore } from 'react';
import { ru } from '../i18n/ru.ts';
import type { UploadProgress } from './upload-progress.ts';
import styles from './attachments.module.css';

const RADIUS = 6;
const AROUND = 2 * Math.PI * RADIUS;

function Ring({ percent }: { percent: number }) {
  return (
    <svg className={styles.ring} width="16" height="16" viewBox="0 0 16 16" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={ru.chat.uploadedShare(percent)}>
      <circle className={styles.ringTrack} cx="8" cy="8" r={RADIUS} />
      <circle className={styles.ringArc} cx="8" cy="8" r={RADIUS} strokeDasharray={AROUND} strokeDashoffset={AROUND * (1 - percent / 100)} transform="rotate(-90 8 8)" />
    </svg>
  );
}

export function FileRing({ progress, id }: { progress: UploadProgress; id: number }) {
  const percent = useSyncExternalStore(progress.subscribe, () => Math.round(progress.fileShare(id) * 100));
  return <Ring percent={percent} />;
}

// «Загружаю ещё 3 · 37%»: the files still going and the share of all the bytes of the batch.
export function BatchProgress({ progress, left }: { progress: UploadProgress; left: number }) {
  const percent = useSyncExternalStore(progress.subscribe, () => Math.round(progress.batchShare() * 100));
  return (
    <>
      <Ring percent={percent} />
      {ru.chat.uploadingMoreShare(left, percent)}
    </>
  );
}
