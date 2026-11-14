// «Ждёт подтверждения» (spec, section 7): questions of background tasks with «Да»/«Нет», and the
// runs that did not work out during the last week.
import type { FailedRun, PendingApproval } from '@bba/contracts';
import { useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { useNotifications } from '../layout/notifications.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dateTime, timeLeft } from '../ui/format.ts';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { decideApproval, fetchApprovals } from './api.ts';

const MAX_VALUE_LENGTH = 300;

function failureText(f: FailedRun): string {
  const task = f.task ?? ru.approvals.noTask;
  if (f.event === 'approval_expired') return ru.approvals.expired;
  if (f.event === 'background_skipped') return f.code?.startsWith('APP_TASK_PAUSED') ? ru.approvals.paused(task) : ru.approvals.skipped(task, dateTime(f.at));
  return ru.approvals.failed(task, dateTime(f.at));
}

function Args({ args }: { args: unknown }) {
  if (!args || typeof args !== 'object') return null;
  return (
    <dl className="approval-args">
      {Object.entries(args as Record<string, unknown>).map(([k, v]) => {
        const text = typeof v === 'string' ? v : JSON.stringify(v);
        return (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function Question({ item, onDecided, onError }: { item: PendingApproval; onDecided: () => void; onError: (e: ApiRequestError) => void }) {
  const [busy, setBusy] = useState(false);
  async function decide(approved: boolean) {
    setBusy(true);
    try {
      await decideApproval(item.id, approved);
      onDecided();
    } catch (raw) {
      onError(asApiError(raw));
      setBusy(false);
    }
  }
  return (
    <li className="approval-card">
      <p className="approval-title">
        {item.agent} · {item.task ? ru.approvals.task(item.task) : ru.approvals.noTask}
      </p>
      <p>{item.tool}</p>
      <Args args={item.args} />
      <p className="muted">
        {ru.approvals.asked(dateTime(item.createdAt))}, {ru.approvals.expiresIn(timeLeft(item.expiresAt))}
      </p>
      <div className="approval-buttons">
        <button type="button" disabled={busy} onClick={() => void decide(true)}>
          {ru.approvals.yes}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void decide(false)}>
          {ru.approvals.no}
        </button>
      </div>
    </li>
  );
}

export function ApprovalsPage() {
  const { state, reload } = useLoad(fetchApprovals);
  const { refresh } = useNotifications();
  const [error, setError] = useState<ApiRequestError | null>(null);
  const decided = () => {
    setError(null);
    reload();
    refresh();
  };
  return (
    <section>
      <h1>{ru.approvals.title}</h1>
      {error ? <ErrorBanner error={error} /> : null}
      {state.status === 'loading' ? <Skeleton rows={3} /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? (
        <>
          {state.data.pending.length === 0 ? <p className="empty">{ru.approvals.empty}</p> : null}
          <ul className="plain-list">
            {state.data.pending.map((item) => (
              <Question key={item.id} item={item} onDecided={decided} onError={setError} />
            ))}
          </ul>
          {state.data.failed.length > 0 ? (
            <>
              <h2>{ru.approvals.failedTitle}</h2>
              <ul className="plain-list">
                {state.data.failed.map((f, i) => (
                  <li key={i} className="failure">
                    <span>
                      {f.agent}: {failureText(f)}
                    </span>
                    {f.code ? <span className="banner-code"> {f.code}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
