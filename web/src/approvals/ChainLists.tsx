// Requests of multi-step approvals on «Ждёт подтверждения» (docs/specs/[20.11.2026]-multi-step-approvals.md, scenarios
// 3 and 5): those waiting for my decision — the action with its parameters, who asks through which agent, «Зачем», the
// stage — with «Согласовать» and «Отклонить» (a reason required); and my own, with «Отозвать» and «Повторить выполнение».
import type { ChainDto } from '@bba/contracts';
import { useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { useNotifications } from '../layout/notifications.tsx';
import { Button, cx } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { TextArea } from '../ui/Field.tsx';
import { whenLabel } from '../ui/format.ts';
import { Icon } from '../ui/Icon.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { decideChain, fetchChains, retryChain, withdrawChain } from './api.ts';
import styles from './approvals.module.css';

const MAX_VALUE_LENGTH = 300;

function statusText(c: ChainDto): string {
  const s = ru.chains.status;
  if (c.status === 'pending') return s.pending(c.stage, c.stages.length, c.stages[c.stage - 1] ?? '');
  if (c.status === 'failed') return s.failed(c.errorCode);
  return s[c.status];
}

function Args({ chain }: { chain: ChainDto }) {
  if (!chain.args || typeof chain.args !== 'object') return null;
  const entries = Object.entries(chain.args as Record<string, unknown>);
  if (entries.length === 0) return null;
  return (
    <dl className={styles.fields}>
      {entries.map(([key, v]) => {
        const text = chain.action.choices?.[key]?.[String(v)] ?? (typeof v === 'string' ? v : JSON.stringify(v));
        return (
          <div key={key} className={styles.field}>
            <dt>{chain.action.fields[key] ?? key}</dt>
            <dd>{text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function ChainCard({ chain, onChanged }: { chain: ChainDto; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiRequestError | null>(null);
  const { refresh } = useNotifications();
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      refresh();
      onChanged();
    } catch (raw) {
      setError(asApiError(raw));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className={cx(styles.card)} aria-label={ru.chains.number(chain.id, chain.stage, chain.stages.length)}>
      <div className={styles.cardRow}>
        <span className={styles.tile}>
          <Icon name="users" size={18} />
        </span>
        <div className={styles.main}>
          <div className={styles.head}>
            <span className={styles.title}>{ru.chains.number(chain.id, chain.stage, chain.stages.length)}</span>
            <span>{statusText(chain)}</span>
          </div>
          <div className={styles.what}>{chain.action.title}</div>
          <Args chain={chain} />
          <p className={styles.chainNote}>{ru.chains.requester(chain.requester, chain.agent, whenLabel(chain.createdAt))}</p>
          <p className={styles.chainNote}>
            <strong>{ru.chains.why}:</strong> {chain.comment}
          </p>
          {chain.decisions
            .filter((d) => d.decision === 'declined' && d.reason)
            .map((d) => (
              <p key={d.at} className={styles.chainNote}>
                {`${d.name ?? ''}: «${d.reason ?? ''}»`}
              </p>
            ))}
          {declining ? (
            <label className={styles.chainReason}>
              <span>{ru.chains.declineReason}</span>
              <TextArea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          ) : null}
        </div>
        <div className={styles.buttons}>
          {chain.canDecide && !declining ? (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setDeclining(true)}>
                {ru.chains.decline}
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => void act(() => decideChain(chain.id, true))}>
                {ru.chains.approve}
              </Button>
            </>
          ) : null}
          {chain.canDecide && declining ? (
            <Button variant="danger" disabled={busy || reason.trim() === ''} onClick={() => void act(() => decideChain(chain.id, false, reason))}>
              {ru.chains.decline}
            </Button>
          ) : null}
          {chain.canWithdraw ? (
            <Button variant="secondary" disabled={busy} onClick={() => void act(() => withdrawChain(chain.id))}>
              {ru.chains.withdraw}
            </Button>
          ) : null}
          {chain.canRetry ? (
            <Button variant="primary" disabled={busy} onClick={() => void act(() => retryChain(chain.id))}>
              {ru.chains.retry}
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <ErrorBanner error={error} /> : null}
    </article>
  );
}

export function ChainLists() {
  // Fresh at each opening: a decision acts on what is shown.
  const { state, reload } = useLoad(fetchChains);
  if (state.status === 'loading') return <DelayedBar />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const { forMe, mine } = state.data;
  if (forMe.length === 0 && mine.length === 0) return null;
  return (
    <>
      {forMe.length > 0 ? (
        <section className={styles.chainSection} aria-label={ru.chains.forMe}>
          <h2 className={styles.chainSectionTitle}>{ru.chains.forMe}</h2>
          {forMe.map((c) => (
            <ChainCard key={c.id} chain={c} onChanged={reload} />
          ))}
        </section>
      ) : null}
      {mine.length > 0 ? (
        <section className={styles.chainSection} aria-label={ru.chains.mine}>
          <h2 className={styles.chainSectionTitle}>{ru.chains.mine}</h2>
          {mine.map((c) => (
            <ChainCard key={c.id} chain={c} onChanged={reload} />
          ))}
        </section>
      ) : null}
    </>
  );
}
