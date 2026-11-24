// «Настройки → Мои обращения» (docs/specs/[20.11.2026]-feedback-and-value.md, scenario 2): the person's own complaints,
// their state and the answer of the support. Never memorised: the answer comes while the page is closed, and its
// notification opens it fresh.
import { ru } from '../i18n/ru.ts';
import { PageFrame } from '../shell/PageFrame.tsx';
import { Card, EmptyState, Pill } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dateTime } from '../i18n/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { myTickets } from './api.ts';
import styles from './feedback.module.css';
import { STATUS_TONE } from './SupportSection.tsx';

const t = ru.feedback.requests;

export function MyRequestsPage() {
  const { state, reload } = useLoad(myTickets);
  return (
    <PageFrame title={t.title} lead={t.lead}>
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' && state.data.tickets.length === 0 ? <EmptyState title={t.empty} text={t.emptyText} /> : null}
      {state.status === 'ready'
        ? state.data.tickets.map((x) => (
            <Card key={x.id} className="rise" label={t.head(x.id, x.agentName, dateTime(x.createdAt))}>
              <div className={styles.section}>
                <div className={styles.headRow}>
                  <div className={styles.rowMain}>
                    <div className={styles.rowTitle}>{t.head(x.id, x.agentName, dateTime(x.createdAt))}</div>
                  </div>
                  <Pill tone={STATUS_TONE[x.status]}>{ru.feedback.support.status[x.status]}</Pill>
                </div>
                <h3 className={styles.sectionTitle}>{t.yours}</h3>
                <p className={styles.pre}>{x.comment}</p>
                <h3 className={styles.sectionTitle}>{t.answer}</h3>
                <p className={x.reply ? styles.pre : styles.note}>{x.reply ?? t.noAnswer}</p>
              </div>
            </Card>
          ))
        : null}
    </PageFrame>
  );
}
