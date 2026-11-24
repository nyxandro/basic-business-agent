// «Ждёт подтверждения» (spec, section 7; mockup): questions of background tasks and of conversations and what did not
// work out during the last week. A notification leads here with `?question=…`: the question is marked, and one decided
// meanwhile tells what became of it instead of an empty screen (docs/specs/[20.11.2026]-notifications.md, section 9).
import type { ApprovalStateResponse } from '@bba/contracts';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiRequestError, asApiError } from '../api/client.ts';
import { notificationTexts } from '../i18n/notifications.ts';
import { ru } from '../i18n/ru.ts';
import { useShell } from '../shell/shell-context.ts';
import { PageFrame } from '../shell/PageFrame.tsx';
import { fetchApprovalState } from '../notifications/api.ts';
import { ErrorBanner, Notice } from '../ui/ErrorBanner.tsx';
import { whenLabel } from '../i18n/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { fetchApprovals } from './api.ts';
import { ApprovalLists } from './ApprovalCards.tsx';
import { ChainLists } from './ChainLists.tsx';

const HTTP_NOT_FOUND = 404;

function decidedText(state: ApprovalStateResponse): string {
  const when = state.decidedAt ? whenLabel(state.decidedAt) : '';
  if (state.status === 'approved') return notificationTexts.decided.approved(when);
  if (state.status === 'declined') return notificationTexts.decided.declined(when);
  if (state.status === 'expired') return notificationTexts.decided.expired(when);
  return notificationTexts.decided.failed(when);
}

// The question of an old notification that is not among the waiting ones any more.
function Decided({ id }: { id: string }) {
  const [state, setState] = useState<ApprovalStateResponse | ApiRequestError | null>(null);
  useEffect(() => {
    let current = true;
    fetchApprovalState(id).then(
      (next) => current && setState(next),
      (raw: unknown) => current && setState(asApiError(raw)),
    );
    return () => {
      current = false;
    };
  }, [id]);
  if (!state) return null;
  if (state instanceof ApiRequestError) return state.status === HTTP_NOT_FOUND ? <Notice>{notificationTexts.questionGone}</Notice> : <ErrorBanner error={state} />;
  if (state.status === 'pending') return null;
  return (
    <Notice>
      <strong>{state.action}</strong>
      <br />
      {decidedText(state)}
    </Notice>
  );
}

export function ApprovalsPage() {
  // «Да» and «Нет» act on what is shown: a question answered meanwhile must not come back from memory.
  const { state, reload } = useLoad(fetchApprovals);
  const { wide } = useShell();
  const [params] = useSearchParams();
  const question = params.get('question');
  const waiting = state.status === 'ready' && question !== null && state.data.pending.some((p) => p.id === question);
  return (
    <PageFrame title={ru.approvals.title} lead={ru.approvals.lead}>
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner title={ru.approvals.loadFailed} error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? (
        <div>
          {question && !waiting ? <Decided id={question} /> : null}
          <ApprovalLists data={state.data} compact={!wide} onNavigate={() => undefined} highlighted={question} />
          <ChainLists />
        </div>
      ) : null}
    </PageFrame>
  );
}
