// The breakdown of the last fire of a task by people (spec, scenario 4): who it went through for,
// who waits for a decision, who failed and who was skipped — and why.
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
import { runText } from './tasks-text.ts';

const TONES: Record<string, Tone> = { done: 'ok', 'awaiting-approval': 'accent', failed: 'bad', skipped: 'warn', queued: 'neutral', running: 'neutral' };

function RunsBody({ task }: { task: AdminTask }) {
  const load = useCallback(() => adminApi.taskRuns(task.id), [task.id]);
  const { state, reload } = useLoad(load);
  if (state.status === 'loading') return <DelayedBar />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  if (!state.data.fireAt) return <p className={section.note}>Задача ещё не запускалась.</p>;
  return (
    <>
      <p className={section.note}>Запуск {dateTime(state.data.fireAt)}</p>
      <ul className={styles.runs}>
        {state.data.runs.map((r) => (
          <li key={r.userId} className={styles.run}>
            <span className={styles.runName}>{r.name}</span>
            <Pill tone={TONES[r.outcome] ?? 'neutral'}>{runText(r)}</Pill>
          </li>
        ))}
      </ul>
    </>
  );
}

export function TaskRuns({ task, onClose }: { task: AdminTask; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} label={`Разбивка: ${task.title}`}>
      <div className={section.form}>
        <h2 className={section.formTitle}>{task.title}</h2>
        <RunsBody task={task} />
      </div>
    </Modal>
  );
}
