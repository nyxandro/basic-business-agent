// «Ждёт подтверждения» (spec, section 7; mockup): questions of background tasks and what did not
// work out during the last week. A phone opens the same lists as a sheet from the bell.
import { ru } from '../i18n/ru.ts';
import { ChatHeaderBar } from '../layout/ChatHeader.tsx';
import { useShell } from '../layout/AppShell.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { fetchApprovals } from './api.ts';
import { ApprovalLists } from './ApprovalCards.tsx';
import styles from './approvals.module.css';

export function ApprovalsPage() {
  const { state, reload } = useLoad(fetchApprovals);
  const { wide, openMenu } = useShell();
  return (
    <>
      {wide ? null : <ChatHeaderBar title={ru.approvals.title} onOpenMenu={openMenu} />}
      <div className={styles.page}>
        <h1 className={`${styles.pageTitle} rise`}>{ru.approvals.title}</h1>
        <p className={`${styles.lead} rise`}>{ru.approvals.lead}</p>
        {state.status === 'loading' ? <Skeleton rows={3} /> : null}
        {state.status === 'error' ? <ErrorBanner title={ru.approvals.loadFailed} error={state.error} onRetry={reload} /> : null}
        {state.status === 'ready' ? <ApprovalLists data={state.data} compact={!wide} onNavigate={() => undefined} /> : null}
      </div>
    </>
  );
}
