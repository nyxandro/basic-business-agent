// «Настройки → Мои обращения» (docs/specs/[20.11.2026]-feedback-and-value.md, scenario 2; F7–F9, owner 24.11): the person's
// tickets — requests to the support and complaints about answers — the latest activity first, each opening its
// conversation; «Новое обращение» writes to the support and opens the new ticket. Never memorised, and read again at
// once when the server says there is news (an answer of the support); when that fails, the list stays, under the error.
import type { MyTicketRow } from '@bba/contracts';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { dateTime } from '../i18n/format.ts';
import { ru } from '../i18n/ru.ts';
import { useOnLiveNews } from '../notifications/live.ts';
import { PageFrame } from '../shell/PageFrame.tsx';
import { Button, cx } from '../ui/Button.tsx';
import { Card, EmptyState, Pill } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { myTickets } from './api.ts';
import { RequestDialog } from './RequestDialog.tsx';
import { STATUS_TONE } from './TicketChat.tsx';
import styles from './feedback.module.css';

const t = ru.feedback.requests;

// A request is named by its subject, a complaint by its agent.
export const myTitleOf = (x: Pick<MyTicketRow, 'kind' | 'subject' | 'agentName'>) => (x.kind === 'request' ? (x.subject ?? '') : t.complaintTitle(x.agentName ?? ''));

export function MyRequestsPage() {
  const { state, reload } = useLoad(myTickets);
  const [writing, setWriting] = useState(false);
  const navigate = useNavigate();
  useOnLiveNews(reload);
  const data = state.status === 'ready' ? state.data : state.status === 'error' ? (state.stale ?? null) : null;
  return (
    <PageFrame
      title={t.title}
      lead={t.lead}
      actions={
        <Button variant="primary" icon="plus" onClick={() => setWriting(true)}>
          {t.create}
        </Button>
      }
    >
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {data && data.tickets.length === 0 ? <EmptyState title={t.empty} text={t.emptyText} /> : null}
      {data && data.tickets.length > 0 ? (
        <Card className="rise">
          <ul className={styles.list} aria-label={t.title}>
            {data.tickets.map((x) => (
              <li key={x.id} className={styles.row}>
                <Link to={`/settings/requests/${encodeURIComponent(x.id)}`} className={cx(styles.rowMain, styles.rowLink)}>
                  <div className={styles.rowTitle}>{myTitleOf(x)}</div>
                  <div className={styles.rowSub}>{t.row(x.id, dateTime(x.updatedAt))}</div>
                </Link>
                <Pill tone={STATUS_TONE.employee[x.status]}>{ru.feedback.ticket.status[x.status]}</Pill>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <RequestDialog
        open={writing}
        onClose={() => setWriting(false)}
        onSent={(id) => {
          setWriting(false);
          void navigate(`/settings/requests/${encodeURIComponent(id)}`);
        }}
      />
    </PageFrame>
  );
}
