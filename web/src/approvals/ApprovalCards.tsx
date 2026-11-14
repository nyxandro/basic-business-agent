// The cards of «Ждёт подтверждения» (mockup): a question of a background task — the task, the
// agent, what the action will do with its fields, when it was asked and when it expires, «Нет» /
// «Да, выполнить», then «Выполнено» / «Отклонено» in place; and «Не получилось» with
// «Подключить заново» when the task lost access to a system. `compact` is the phone's sheet.
import type { ApprovalsResponse, FailedRun, PendingApproval } from '@bba/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { useNotifications } from '../layout/notifications.tsx';
import { Button, cx } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { timeLeft, whenLabel } from '../ui/format.ts';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { decideApproval } from './api.ts';
import styles from './approvals.module.css';

const MAX_VALUE_LENGTH = 300;
// Failures a new sign-in to the system fixes (spec, section 13).
const ACCESS_CODES = new Set(['APP_CONNECTOR_AUTH_FAILED', 'APP_CONNECTOR_NOT_CONNECTED', 'APP_CONNECTOR_DECRYPT_FAILED']);

// Mail actions get the envelope, the rest work with a system's records.
const actionIcon = (tool: string): IconName => (tool.startsWith('mail') ? 'mail' : 'db');

function Fields({ item }: { item: PendingApproval }) {
  if (!item.args || typeof item.args !== 'object') return null;
  const entries = Object.entries(item.args as Record<string, unknown>);
  if (entries.length === 0) return null;
  return (
    <dl className={styles.fields}>
      {entries.map(([key, v]) => {
        const text = typeof v === 'string' ? v : JSON.stringify(v);
        return (
          <div key={key} className={styles.field}>
            <dt>{item.action.fields[key] ?? key}</dt>
            <dd>{text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text}</dd>
          </div>
        );
      })}
    </dl>
  );
}

type Decision = 'pending' | 'busy' | 'yes' | 'no';

function Question({ item, compact }: { item: PendingApproval; compact: boolean }) {
  const [decision, setDecision] = useState<Decision>('pending');
  const [error, setError] = useState<ApiRequestError | null>(null);
  const { refresh } = useNotifications();
  async function decide(approved: boolean) {
    setDecision('busy');
    setError(null);
    try {
      await decideApproval(item.id, approved);
      setDecision(approved ? 'yes' : 'no');
      refresh();
    } catch (raw) {
      setError(asApiError(raw));
      setDecision('pending');
    }
  }
  const asked = ru.approvals.asked(whenLabel(item.createdAt));
  const left = ru.approvals.expiresIn(timeLeft(item.expiresAt));
  const decided = decision === 'yes' || decision === 'no';
  return (
    <article className={cx(styles.card, compact && styles.compact)}>
      <div className={styles.cardRow}>
        <span className={styles.tile}>
          <Icon name={actionIcon(item.tool)} size={compact ? 15 : 18} />
        </span>
        <div className={styles.main}>
          <div className={styles.head}>
            <span className={styles.title}>{item.task ?? ru.approvals.noTask}</span>
            <span>{ru.approvals.agent(item.agent)}</span>
          </div>
          <div className={styles.what}>{item.action.title}</div>
          <Fields item={item} />
          <div className={styles.meta}>
            <span>{asked}</span>
            <span className={styles.left}>
              <Icon name="clock" size={14} />
              {left}
            </span>
          </div>
        </div>
        {!compact && !decided ? (
          <div className={styles.buttons}>
            <Button variant="secondary" disabled={decision === 'busy'} onClick={() => void decide(false)}>
              {ru.approvals.no}
            </Button>
            <Button variant="primary" disabled={decision === 'busy'} onClick={() => void decide(true)}>
              {ru.approvals.yes}
            </Button>
          </div>
        ) : null}
        {!compact && decided ? <span className={cx(styles.result, decision === 'yes' && styles.resultOk)}>{decision === 'yes' ? ru.approvals.done : ru.approvals.declined}</span> : null}
      </div>
      {compact && !decided ? (
        <div className={styles.buttonsPhone}>
          <Button variant="secondary" size="lg" disabled={decision === 'busy'} onClick={() => void decide(false)}>
            {ru.approvals.no}
          </Button>
          <Button variant="primary" size="lg" disabled={decision === 'busy'} onClick={() => void decide(true)}>
            {ru.approvals.yes}
          </Button>
        </div>
      ) : null}
      {compact && decided ? <div className={cx(styles.result, styles.resultBlock, decision === 'yes' && styles.resultOk)}>{decision === 'yes' ? ru.approvals.done : ru.approvals.declined}</div> : null}
      {error ? <ErrorBanner error={error} /> : null}
    </article>
  );
}

function failureTitle(f: FailedRun): string {
  if (f.code && ACCESS_CODES.has(f.code)) return ru.approvals.accessLost;
  if (f.event === 'approval_expired') return ru.approvals.expired;
  if (f.event === 'background_skipped') return f.code?.startsWith('APP_TASK_PAUSED') ? ru.approvals.paused : ru.approvals.skipped;
  return ru.approvals.failed;
}

function Failure({ f, onNavigate }: { f: FailedRun; onNavigate: () => void }) {
  return (
    <div className={styles.failure}>
      <Icon name="alert" className={styles.warn} />
      <div className={styles.main}>
        <div className={styles.failureTitle}>{failureTitle(f)}</div>
        <div className={styles.meta}>
          {ru.approvals.failureMeta(f.task ?? ru.approvals.noTask, f.agent, whenLabel(f.at))}
          {f.code ? <span className={styles.code}> · {f.code}</span> : null}
        </div>
      </div>
      {f.code && ACCESS_CODES.has(f.code) ? (
        <Link to="/settings/connections" className={styles.reconnect} onClick={onNavigate}>
          {ru.approvals.reconnect}
        </Link>
      ) : null}
    </div>
  );
}

export function ApprovalLists({ data, compact, onNavigate }: { data: ApprovalsResponse; compact: boolean; onNavigate: () => void }) {
  return (
    <>
      {data.pending.length === 0 ? <p className={styles.empty}>{ru.approvals.empty}</p> : null}
      <div className={styles.list}>
        {data.pending.map((item, i) => (
          <div key={item.id} className="rise" style={{ animationDelay: `${Math.min(i, 6) * 0.06}s` }}>
            <Question item={item} compact={compact} />
          </div>
        ))}
      </div>
      {data.failed.length > 0 ? (
        <>
          <h2 className={styles.section}>{ru.approvals.failedTitle}</h2>
          <div className={styles.list}>
            {data.failed.map((f, i) => (
              <Failure key={`${f.at}-${i}`} f={f} onNavigate={onNavigate} />
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
