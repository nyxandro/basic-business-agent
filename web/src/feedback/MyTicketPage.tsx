// A ticket of the person (docs/specs/[20.11.2026]-feedback-and-value.md, F9; owner 24.11, by the classic help desks): its
// conversation with the support — the person's messages on the right, the support's on the left, each with its files —
// and the field to write while it is open; «Проблема решена» closes it for both sides. A closed ticket says who closed it
// and offers a new one. The page reads the ticket again at once when the server says there is news (a support's answer).
import { isClosedStatus, type MyTicketDto } from '@bba/contracts';
import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { asApiError } from '../api/client.ts';
import { dateTime } from '../i18n/format.ts';
import { ru } from '../i18n/ru.ts';
import { useLiveNews } from '../notifications/live.ts';
import { PageFrame } from '../shell/PageFrame.tsx';
import { Button } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, Pill } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { useToast } from '../ui/Toast.tsx';
import { useLoad } from '../ui/use-load.ts';
import { myFileUrl, myTicket, resolveMine, writeMine } from './api.ts';
import { myTitleOf } from './MyRequestsPage.tsx';
import { RequestDialog } from './RequestDialog.tsx';
import { STATUS_TONE, TicketComposer, TicketMessages } from './TicketChat.tsx';
import styles from './feedback.module.css';

const t = ru.feedback.requests;
const tt = ru.feedback.ticket;

function Conversation({ data, onChanged }: { data: MyTicketDto; onChanged: () => void }) {
  const closed = isClosedStatus(data.status);
  return (
    <Card className="rise">
      <TicketMessages
        messages={data.messages}
        mine="employee"
        nameOf={(m) => (m.side === 'employee' ? tt.you : m.author ? tt.supportOf(m.author) : tt.support)}
        fileUrl={(ord) => myFileUrl(data.id, ord)}
      />
      {closed && data.closedSide && data.closedAt ? (
        <p className={styles.closedNote}>{tt.closedNote(tt.closedYou[data.closedSide], tt.status[data.status], dateTime(data.closedAt))}</p>
      ) : (
        <TicketComposer
          onSend={async (text, files) => {
            await writeMine(data.id, text, files);
            onChanged();
          }}
        />
      )}
    </Card>
  );
}

export function MyTicketPage() {
  const { ticketId = '' } = useParams();
  const load = useCallback(() => myTicket(ticketId), [ticketId]);
  const { state, reload } = useLoad(load);
  const [writing, setWriting] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const news = useLiveNews();
  const onNews = useEffectEvent(reload);
  useEffect(() => {
    if (news > 0) onNews();
  }, [news]);
  const data = state.status === 'ready' ? state.data : null;

  async function resolve(id: string) {
    if (!(await confirm({ title: t.resolveTitle, text: t.resolveText, confirmLabel: t.resolveConfirm }))) return;
    try {
      await resolveMine(id);
      toast(t.resolved);
      reload();
    } catch (raw) {
      const error = asApiError(raw);
      toast(`${error.message} Код: ${error.code}`);
    }
  }

  return (
    <PageFrame
      title={data ? myTitleOf(data) : t.title}
      lead={data ? t.row(data.id, dateTime(data.createdAt)) : undefined}
      actions={
        data ? (
          <div className={styles.headActions}>
            <Pill tone={STATUS_TONE.employee[data.status]}>{tt.status[data.status]}</Pill>
            {isClosedStatus(data.status) ? (
              <Button icon="plus" onClick={() => setWriting(true)}>
                {t.newAfterClosed}
              </Button>
            ) : (
              <Button icon="check" onClick={() => void resolve(data.id)}>
                {t.resolve}
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      <Link to="/settings/requests" className={styles.note}>
        ← {t.back}
      </Link>
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {data ? (
        <Conversation data={data} onChanged={reload} />
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
