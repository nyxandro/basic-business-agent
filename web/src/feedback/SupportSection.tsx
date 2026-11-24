// «Поддержка» (docs/specs/[20.11.2026]-feedback-and-value.md, scenario 2; owner 21.11, F5; 24.11, F7–F9): the tickets of
// employees — requests written straight and complaints about answers — for the people with «Агенты»: a list with its
// state filter, the latest activity first, and a ticket. A ticket is a conversation with its employee (TicketChat.tsx):
// the support answers with files while it is open, closes it as resolved or rejected, opens a closed one again. A
// complaint shows above it, for the support only, the conversation as it was with the answer complained about marked,
// its files, the agent, the models and the version of the instructions. Both read again at once when the server says
// there is news (a message of the employee, a colleague's answer).
import type { AdminTicketDto, AdminTicketRow, SupportStatus } from '@bba/contracts';
import { isClosedStatus, SUPPORT_STATUSES } from '@bba/contracts';
import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button, ButtonLink, cx } from '../ui/Button.tsx';
import { Card, EmptyState, PageHead, Pill } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dateTime, fileSize, fullDate } from '../i18n/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { ru } from '../i18n/ru.ts';
import { useLiveNews } from '../notifications/live.ts';
import { Feedback, useAction } from '../ui/form-parts.tsx';
import chips from '../ui/chips.module.css';
import { setTicketStatus, ticket, ticketFileUrl, tickets, writeAsSupport } from './api.ts';
import { STATUS_TONE, TicketComposer, TicketMessages } from './TicketChat.tsx';
import styles from './feedback.module.css';

const t = ru.feedback.support;
const tt = ru.feedback.ticket;

// A request is named by its subject, a complaint by its agent.
const titleOf = (x: AdminTicketRow) => (x.kind === 'request' ? t.numberWithSubject(x.id, x.subject ?? '') : t.number(x.id));
const lineOf = (x: AdminTicketRow, when: string) => (x.kind === 'request' ? t.requestRow(x.author ?? tt.formerEmployee, when) : t.row(x.author ?? tt.formerEmployee, x.agentName ?? '', when));

// Reads its data again when the frame of the admin panel hears news.
function useReloadOnNews(reload: () => void) {
  const news = useLiveNews();
  const onNews = useEffectEvent(reload);
  useEffect(() => {
    if (news > 0) onNews();
  }, [news]);
}

export function SupportSection() {
  const [status, setStatus] = useState<SupportStatus | null>(null);
  const load = useCallback(() => tickets(status), [status]);
  const { state, reload } = useLoad(load);
  useReloadOnNews(reload);
  return (
    <div className={styles.stack}>
      <PageHead title={t.title} lead={t.lead} />
      <div role="group" aria-label={t.stateFilter} className={chips.row}>
        {[null, ...SUPPORT_STATUSES].map((s) => (
          <button key={s ?? 'all'} type="button" aria-pressed={status === s} className={cx(chips.chip, status === s && chips.on)} onClick={() => setStatus(s)}>
            {s ? tt.status[s] : t.all}
          </button>
        ))}
      </div>
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' && state.data.tickets.length === 0 ? <EmptyState title={t.empty} text={t.emptyText} /> : null}
      {state.status === 'ready' && state.data.tickets.length > 0 ? (
        <Card className="rise">
          <ul className={styles.list} aria-label={t.title}>
            {state.data.tickets.map((x) => (
              <li key={x.id} className={styles.row}>
                <Link to={`/admin/support/${encodeURIComponent(x.id)}`} className={cx(styles.rowMain, styles.rowLink)}>
                  <div className={styles.rowTitle}>{titleOf(x)}</div>
                  <div className={styles.rowSub}>{lineOf(x, dateTime(x.updatedAt))}</div>
                </Link>
                <Pill tone={STATUS_TONE.support[x.status]}>{tt.status[x.status]}</Pill>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function Snapshot({ data }: { data: AdminTicketDto }) {
  return (
    <div className={styles.thread} aria-label={t.conversation}>
      {data.snapshot.map((m, i) => (
        <div key={i} className={cx(styles.message, m.role === 'user' && styles.mine, m.role === 'assistant' && m.turn === data.turn && styles.complained)} aria-label={m.role === 'assistant' && m.turn === data.turn ? t.complained : undefined}>
          <span className={styles.who}>
            {m.role === 'user' ? t.you : t.agent} · {dateTime(m.at)}
          </span>
          {m.text}
          {m.marks.length > 0 ? (
            <ul className={styles.marks}>
              {m.marks.map((mark, j) => (
                <li key={j}>{mark}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// What a complaint brings to the support only: the agent and the models, the conversation as it was, its files.
function ComplaintContext({ data }: { data: AdminTicketDto }) {
  return (
    <>
      <Card className="rise">
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>{t.trace}</h2>
          <p className={styles.note}>
            {t.traceLine(data.agentName ?? '', data.models.length > 0 ? data.models.join(', ') : t.noModel, data.instructionsAt ? t.instructionsOf(fullDate(data.instructionsAt)) : t.instructionsFile)}
            {data.taskId ? ` · ${t.task}` : ''}
          </p>
        </div>
      </Card>
      <Card className="rise">
        <h2 className={cx(styles.sectionTitle, styles.section)}>{t.conversation}</h2>
        <Snapshot data={data} />
      </Card>
      <Card className="rise">
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>{t.files}</h2>
          {data.contextFiles.length === 0 ? <p className={styles.note}>{t.noFiles}</p> : null}
          <ul className={styles.list}>
            {data.contextFiles.map((f) => (
              <li key={f.ord} className={styles.row}>
                <div className={styles.rowMain}>
                  <div className={styles.rowTitle}>{f.name}</div>
                  <div className={styles.rowSub}>{f.state === 'copied' ? fileSize(f.size ?? 0) : f.state === 'too_large' ? t.fileTooLarge(fileSize(f.size ?? 0)) : t.fileGone}</div>
                </div>
                {f.state === 'copied' ? (
                  <ButtonLink href={ticketFileUrl(data.id, f.ord)} download={f.name} icon="download" size="sm" aria-label={tt.downloadFile(f.name)}>
                    {tt.download}
                  </ButtonLink>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </Card>
    </>
  );
}

// Closing as resolved or rejected while open, opening again when closed.
function StatusActions({ data, onChanged }: { data: AdminTicketDto; onChanged: () => void }) {
  const { busy, error, run } = useAction();
  const change = (status: 'resolved' | 'rejected' | 'open', done: string) =>
    void run(async () => {
      await setTicketStatus(data.id, status);
      onChanged();
    }, done);
  return (
    <>
      <div className={styles.headActions}>
        <Pill tone={STATUS_TONE.support[data.status]}>{tt.status[data.status]}</Pill>
        {isClosedStatus(data.status) ? (
          <Button disabled={busy} onClick={() => change('open', t.reopened)}>
            {t.reopen}
          </Button>
        ) : (
          <>
            <Button icon="check" disabled={busy} onClick={() => change('resolved', t.resolved)}>
              {t.resolve}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => change('rejected', t.rejected)}>
              {t.reject}
            </Button>
          </>
        )}
      </div>
      <Feedback error={error} />
    </>
  );
}

export function TicketPage() {
  const { ticketId = '' } = useParams();
  const load = useCallback(() => ticket(ticketId), [ticketId]);
  const { state, reload } = useLoad(load);
  useReloadOnNews(reload);
  const data = state.status === 'ready' ? state.data : null;
  return (
    <div className={styles.stack}>
      <Link to="/admin/support" className={styles.note}>
        ← {t.back}
      </Link>
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {data ? (
        <>
          <PageHead title={`${t.title} ${titleOf(data)}`} lead={lineOf(data, dateTime(data.createdAt))} actions={<StatusActions data={data} onChanged={reload} />} />
          {data.kind === 'complaint' ? <ComplaintContext data={data} /> : null}
          <Card className="rise">
            <h2 className={cx(styles.sectionTitle, styles.section)}>{tt.conversation}</h2>
            <TicketMessages
              messages={data.messages}
              mine="support"
              nameOf={(m) => (m.side === 'employee' ? (m.author ?? tt.formerEmployee) : m.author ? tt.supportOf(m.author) : tt.support)}
              fileUrl={(ord) => ticketFileUrl(data.id, ord)}
            />
            {isClosedStatus(data.status) && data.closedSide && data.closedAt ? (
              <p className={styles.closedNote}>{tt.closedNote(tt.closedBy[data.closedSide], tt.status[data.status], dateTime(data.closedAt))}</p>
            ) : (
              <TicketComposer
                hint={t.replyHint}
                onSend={async (text, files) => {
                  await writeAsSupport(data.id, text, files);
                  reload();
                }}
              />
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
