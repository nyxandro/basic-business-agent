// The cards of «Ждёт подтверждения» (mockup): a question of a background task — the task, the
// agent, what the action will do with its fields, when it was asked and when it expires, «Нет» /
// «Да, выполнить», then «Выполнено» / «Отклонено» in place; a question of a conversation leads to its
// card «Да» there (docs/specs/[20.11.2026]-notifications.md, F4); and «Не получилось» with
// «Подключить заново» when the task lost access to a system. `compact` is the bell's panel.
import type { ApprovalsResponse, FailedRun, PendingApproval } from '@bba/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { notificationTexts } from '../i18n/notifications.ts';
import { ru } from '../i18n/ru.ts';
import { useNotifications } from '../layout/notifications.tsx';
import { Button, cx } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { timeLeft, whenLabel } from '../ui/format.ts';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { decideApproval } from './api.ts';
import { ChainReason, reasonReady, sendForApproval, useChainPreview } from './ChainReason.tsx';
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
        const text = item.action.choices?.[key]?.[String(v)] ?? (typeof v === 'string' ? v : JSON.stringify(v));
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

const threadPath = (c: NonNullable<PendingApproval['conversation']>) => `/agents/${encodeURIComponent(c.agentId)}?thread=${encodeURIComponent(c.threadId)}`;

// A question of a conversation is answered on its card there: the agent's answer goes on in the chat.
function ConversationQuestion({ item, compact, highlighted, onNavigate }: { item: PendingApproval & { conversation: NonNullable<PendingApproval['conversation']> }; compact: boolean; highlighted: boolean; onNavigate: () => void }) {
  return (
    <article className={cx(styles.card, compact && styles.compact, highlighted && styles.highlighted)}>
      <div className={styles.cardRow}>
        <span className={styles.tile}>
          <Icon name="chat" size={compact ? 15 : 18} />
        </span>
        <div className={styles.main}>
          <div className={styles.head}>
            <span className={styles.title}>{notificationTexts.fromConversation(item.conversation.title)}</span>
            <span>{ru.approvals.agent(item.agent)}</span>
          </div>
          <div className={styles.what}>{item.action.title}</div>
          <Fields item={item} />
          <div className={styles.meta}>
            <span>{ru.approvals.asked(whenLabel(item.createdAt))}</span>
            <span className={styles.left}>
              <Icon name="clock" size={14} />
              {ru.approvals.expiresIn(timeLeft(item.expiresAt))}
            </span>
          </div>
          <p className={styles.hint}>{notificationTexts.conversationHint}</p>
        </div>
        <Link to={threadPath(item.conversation)} onClick={onNavigate} className={cx(styles.open, compact && styles.openBlock)}>
          {notificationTexts.openConversation}
        </Link>
      </div>
    </article>
  );
}

function Question({ item, compact, highlighted }: { item: PendingApproval; compact: boolean; highlighted: boolean }) {
  const [decision, setDecision] = useState<Decision>('pending');
  const [error, setError] = useState<ApiRequestError | null>(null);
  const { refresh } = useNotifications();
  // Multi-step approvals: under a rule «Да» sends «Зачем» first and the action goes to the approvers.
  const preview = useChainPreview(item.tool);
  const [reason, setReason] = useState('');
  const chain = preview.status === 'chain';
  const yesBlocked = preview.status === 'loading' || preview.status === 'failed' || (chain && !reasonReady(reason));
  async function decide(approved: boolean) {
    setDecision('busy');
    setError(null);
    try {
      if (approved && chain) await sendForApproval(item.toolCallId, reason, () => undefined);
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
    <article className={cx(styles.card, compact && styles.compact, highlighted && styles.highlighted)}>
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
          {!decided ? <ChainReason preview={preview} reason={reason} onReason={setReason} /> : null}
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
            <Button variant="primary" disabled={decision === 'busy' || yesBlocked} onClick={() => void decide(true)}>
              {chain ? ru.chains.send : ru.approvals.yes}
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
          <Button variant="primary" size="lg" disabled={decision === 'busy' || yesBlocked} onClick={() => void decide(true)}>
            {chain ? ru.chains.send : ru.approvals.yes}
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

// `highlighted` — the question an old notification led to (`/approvals?question=…`).
export function ApprovalLists({ data, compact, onNavigate, highlighted = null }: { data: ApprovalsResponse; compact: boolean; onNavigate: () => void; highlighted?: string | null }) {
  return (
    <>
      {data.pending.length === 0 ? <p className={styles.empty}>{ru.approvals.empty}</p> : null}
      <div className={styles.list}>
        {data.pending.map((item, i) => (
          <div key={item.id} className="rise" style={{ animationDelay: `${Math.min(i, 6) * 0.06}s` }}>
            {item.conversation ? (
              <ConversationQuestion item={{ ...item, conversation: item.conversation }} compact={compact} highlighted={item.id === highlighted} onNavigate={onNavigate} />
            ) : (
              <Question item={item} compact={compact} highlighted={item.id === highlighted} />
            )}
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
