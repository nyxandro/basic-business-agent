// «Последние события» of a task by an event (docs/specs/[20.11.2026]-event-tasks.md, section 7): the 20 latest with
// their outcome; a message of another system with its first characters, a letter with only whose mailbox it came to —
// the mail is the employee's. Messages the address refused in the last day are counted under the list.
import type { AdminTask } from '@bba/contracts';
import { useCallback } from 'react';
import { Pill, type Tone } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dateTime } from '../ui/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { Modal } from '../ui/Modal.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import section from './section.module.css';
import styles from './tasks.module.css';
import { eventText } from './tasks-text.ts';

const TONES: Record<string, Tone> = { done: 'ok', 'awaiting-approval': 'accent', failed: 'bad', queued: 'neutral', skipped_flood: 'warn', skipped_paused: 'warn', skipped_executor: 'warn' };

function EventsBody({ task }: { task: AdminTask }) {
  // Fresh at each opening: the list is what happens now.
  const load = useCallback(() => adminApi.taskEvents(task.id), [task.id]);
  const { state, reload } = useLoad(load);
  if (state.status === 'loading') return <DelayedBar />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const { events, rejected } = state.data;
  const refused = rejected.tooLarge + rejected.badFormat;
  return (
    <>
      {events.length === 0 ? (
        <p className={section.note}>{task.trigger === 'webhook' ? 'Событий пока не было. Отправьте пробное сообщение на адрес задачи.' : 'Событий пока не было: подходящих писем ещё не приходило.'}</p>
      ) : (
        <ul className={styles.events}>
          {events.map((e) => (
            <li key={e.id} className={styles.eventRow}>
              <span className={styles.eventWhen}>{dateTime(e.receivedAt)}</span>
              <span className={styles.eventWhat} title={e.summary ?? undefined}>
                {e.user ?? e.summary ?? ''}
              </span>
              <Pill tone={TONES[e.outcome] ?? 'neutral'}>{eventText(e)}</Pill>
            </li>
          ))}
        </ul>
      )}
      {refused > 0 ? <p className={section.note}>Отклонено за сутки: {refused} (слишком большое — {rejected.tooLarge}, неверный формат — {rejected.badFormat}).</p> : null}
    </>
  );
}

export function TaskEvents({ task, onClose }: { task: AdminTask; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} label={`Последние события: ${task.title}`}>
      <div className={section.form}>
        <h2 className={section.formTitle}>{task.title}</h2>
        <EventsBody task={task} />
      </div>
    </Modal>
  );
}
