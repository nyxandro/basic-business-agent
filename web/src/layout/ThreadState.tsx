// The mark of a conversation in the lists — «Недавние» and the conversations of a project (decision of the owner 22.11):
// a turning blue ring while an agent works there, an amber «!» softly pulsing while a question «Да» waits, a red «!»
// when its answer broke and a green tick when it is ready while nobody watched. Nothing else — no mark.
import type { ThreadState } from '@bba/contracts';
import { notificationTexts as t } from '../i18n/notifications.ts';
import styles from './thread-state.module.css';

function Glyph({ state }: { state: Exclude<ThreadState, 'running'> }) {
  if (state === 'done') return <path d="M7.5 12.4l3 3 6-6.4" />;
  return (
    <>
      <path d="M12 7.5v5.5" />
      <path d="M12 16.4v.1" />
    </>
  );
}

export function ThreadStateMark({ state }: { state: ThreadState | undefined }) {
  if (!state) return null;
  const label = t.threadState[state];
  if (state === 'running') return <span className={styles.ring} role="img" aria-label={label} title={label} />;
  return (
    <span className={`${styles.dot} ${styles[state]}`} role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <Glyph state={state} />
      </svg>
    </span>
  );
}
