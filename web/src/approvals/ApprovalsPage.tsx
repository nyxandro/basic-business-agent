// «Ждёт подтверждения» (spec, section 7; mockup): questions of background tasks and what did not
// work out during the last week. A phone opens the same lists as a sheet from the bell.
import { ru } from '../i18n/ru.ts';
import { useShell } from '../layout/AppShell.tsx';
import { PageFrame } from '../layout/PageFrame.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { fetchApprovals } from './api.ts';
import { ApprovalLists } from './ApprovalCards.tsx';

export function ApprovalsPage() {
  // «Да» and «Нет» act on what is shown: a question answered meanwhile must not come back from memory.
  const { state, reload } = useLoad(fetchApprovals);
  const { wide } = useShell();
  return (
    <PageFrame title={ru.approvals.title} lead={ru.approvals.lead}>
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner title={ru.approvals.loadFailed} error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? (
        <div>
          <ApprovalLists data={state.data} compact={!wide} onNavigate={() => undefined} />
        </div>
      ) : null}
    </PageFrame>
  );
}
