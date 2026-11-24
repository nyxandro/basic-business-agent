// «Настройки → Мои обращения» (docs/specs/[20.11.2026]-feedback-and-value.md, scenario 2; F7, owner 24.11): the person's own
// requests to the support and complaints, their state and the answer of the support; «Новое обращение» writes to the
// support straight. Never memorised: the answer comes while the page is closed, and its notification opens it fresh.
import type { MyTicketDto } from '@bba/contracts';
import { useState } from 'react';
import { ru } from '../i18n/ru.ts';
import { PageFrame } from '../shell/PageFrame.tsx';
import { Button } from '../ui/Button.tsx';
import { Card, EmptyState, Pill } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dateTime } from '../i18n/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { myTickets } from './api.ts';
import { RequestDialog } from './RequestDialog.tsx';
import styles from './feedback.module.css';
import { STATUS_TONE } from './SupportSection.tsx';

const t = ru.feedback.requests;

// A request is named by its subject, a complaint by its agent.
const headOf = (x: MyTicketDto) => (x.kind === 'request' ? t.headRequest(x.id, x.subject ?? '', dateTime(x.createdAt)) : t.head(x.id, x.agentName ?? '', dateTime(x.createdAt)));

export function MyRequestsPage() {
  const { state, reload } = useLoad(myTickets);
  const [writing, setWriting] = useState(false);
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
      {state.status === 'ready' && state.data.tickets.length === 0 ? <EmptyState title={t.empty} text={t.emptyText} /> : null}
      {state.status === 'ready'
        ? state.data.tickets.map((x) => (
            <Card key={x.id} className="rise" label={headOf(x)}>
              <div className={styles.section}>
                <div className={styles.headRow}>
                  <div className={styles.rowMain}>
                    <div className={styles.rowTitle}>{headOf(x)}</div>
                  </div>
                  <Pill tone={STATUS_TONE[x.status]}>{ru.feedback.support.status[x.status]}</Pill>
                </div>
                <h3 className={styles.sectionTitle}>{t.yours}</h3>
                <p className={styles.pre}>{x.comment}</p>
                {x.kind === 'request' && x.files.length > 0 ? <p className={styles.note}>{t.files(x.files)}</p> : null}
                <h3 className={styles.sectionTitle}>{t.answer}</h3>
                <p className={x.reply ? styles.pre : styles.note}>{x.reply ?? t.noAnswer}</p>
              </div>
            </Card>
          ))
        : null}
      <RequestDialog
        open={writing}
        onClose={() => setWriting(false)}
        onSent={() => {
          setWriting(false);
          reload();
        }}
      />
    </PageFrame>
  );
}
