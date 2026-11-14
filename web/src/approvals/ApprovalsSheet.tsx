// «Ждёт подтверждения» on a phone (mockup): a sheet from below over the current screen, opened by
// the bell or from the menu. The questions load each time it opens.
import { useCallback } from 'react';
import { ru } from '../i18n/ru.ts';
import { IconButton } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { Sheet } from '../ui/Modal.tsx';
import { useLoad } from '../ui/use-load.ts';
import { fetchApprovals } from './api.ts';
import { ApprovalLists } from './ApprovalCards.tsx';
import styles from './approvals.module.css';

function SheetBody({ onClose }: { onClose: () => void }) {
  const load = useCallback(() => fetchApprovals(), []);
  const { state, reload } = useLoad(load);
  return (
    <div>
      <div className={styles.sheetHead}>
        <h2 className={styles.sheetTitle}>{ru.approvals.title}</h2>
        <IconButton icon="x" label={ru.approvals.close} onClick={onClose} />
      </div>
      <p className={styles.sheetLead}>{ru.approvals.leadShort}</p>
      {state.status === 'loading' ? <Skeleton rows={2} /> : null}
      {state.status === 'error' ? <ErrorBanner title={ru.approvals.loadFailed} error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? <ApprovalLists data={state.data} compact onNavigate={onClose} /> : null}
    </div>
  );
}

export function ApprovalsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} label={ru.approvals.title}>
      {open ? <SheetBody onClose={onClose} /> : null}
    </Sheet>
  );
}
