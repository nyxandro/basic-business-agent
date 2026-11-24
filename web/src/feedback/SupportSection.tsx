// «Поддержка» (docs/specs/[20.11.2026]-feedback-and-value.md, scenario 2; owner 21.11, F5): the complaints of employees
// about answers and their requests written straight (F7), for the people with «Агенты» — a list with its state filter,
// and a ticket. A complaint: the employee's comment, the conversation as it was with the answer complained about marked,
// its files, the agent, the models and the version of the instructions. A request: its subject, text and the files the
// employee attached. Both: the answer and the state, which go back to the employee as a notification.
import type { AdminTicketDto, AdminTicketRow, SupportStatus } from '@bba/contracts';
import { SUPPORT_NEXT, SUPPORT_STATUSES } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button, ButtonLink, cx } from '../ui/Button.tsx';
import { Card, EmptyState, PageHead, Pill, type Tone } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Select, TextArea } from '../ui/Field.tsx';
import { dateTime, fileSize, fullDate } from '../i18n/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { ru } from '../i18n/ru.ts';
import { Feedback, useAction } from '../ui/form-parts.tsx';
import chips from '../ui/chips.module.css';
import { ticket, ticketFileUrl, tickets, updateTicket } from './api.ts';
import styles from './feedback.module.css';

const t = ru.feedback.support;
export const STATUS_TONE: Record<SupportStatus, Tone> = { new: 'accent', in_progress: 'warn', resolved: 'ok', rejected: 'neutral' };

// A request is named by its subject, a complaint by its agent.
const titleOf = (x: AdminTicketRow) => (x.kind === 'request' ? t.numberWithSubject(x.id, x.subject ?? '') : t.number(x.id));
const lineOf = (x: AdminTicketRow) => (x.kind === 'request' ? t.requestRow(x.author ?? t.formerEmployee, dateTime(x.createdAt)) : t.row(x.author ?? t.formerEmployee, x.agentName ?? '', dateTime(x.createdAt)));

export function SupportSection() {
  const [status, setStatus] = useState<SupportStatus | null>(null);
  const load = useCallback(() => tickets(status), [status]);
  const { state, reload } = useLoad(load);
  return (
    <div className={styles.stack}>
      <PageHead title={t.title} lead={t.lead} />
      <div role="group" aria-label={t.state} className={chips.row}>
        {[null, ...SUPPORT_STATUSES].map((s) => (
          <button key={s ?? 'all'} type="button" aria-pressed={status === s} className={cx(chips.chip, status === s && chips.on)} onClick={() => setStatus(s)}>
            {s ? t.status[s] : t.all}
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
                  <div className={styles.rowSub}>{lineOf(x)}</div>
                </Link>
                <Pill tone={STATUS_TONE[x.status]}>{t.status[x.status]}</Pill>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function Conversation({ data }: { data: AdminTicketDto }) {
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

function Answer({ data, onSaved }: { data: AdminTicketDto; onSaved: (next: AdminTicketDto) => void }) {
  const [status, setStatus] = useState<SupportStatus>(data.status === 'new' ? 'in_progress' : data.status);
  const [reply, setReply] = useState(data.reply ?? '');
  const { busy, error, run } = useAction();
  return (
    <form
      className={styles.section}
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => onSaved(await updateTicket(data.id, { status, reply: reply.trim() || null, seen: data.updatedAt })), t.saved);
      }}
    >
      <h2 className={styles.sectionTitle}>{t.reply}</h2>
      <Field label={t.reply} hint={t.replyHint}>
        <TextArea rows={4} maxLength={4000} value={reply} onChange={(e) => setReply(e.target.value)} />
      </Field>
      <Field label={t.state}>
        <Select value={status} onChange={(e) => setStatus(e.target.value as SupportStatus)}>
          {/* Only where the ticket can go from its state: a closed one opens again. */}
          {SUPPORT_NEXT[data.status].map((s) => (
            <option key={s} value={s}>
              {t.status[s]}
            </option>
          ))}
        </Select>
      </Field>
      <Feedback error={error} />
      {data.handledBy ? <p className={styles.note}>{t.handledBy(data.handledBy)}</p> : null}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={busy}>
          {t.save}
        </Button>
      </div>
    </form>
  );
}

function Files({ data, title, none }: { data: AdminTicketDto; title: string; none: string }) {
  return (
    <Card className="rise">
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {data.files.length === 0 ? <p className={styles.note}>{none}</p> : null}
        <ul className={styles.list}>
          {data.files.map((f) => (
            <li key={f.ord} className={styles.row}>
              <div className={styles.rowMain}>
                <div className={styles.rowTitle}>{f.name}</div>
                <div className={styles.rowSub}>{f.state === 'copied' ? fileSize(f.size ?? 0) : f.state === 'too_large' ? t.fileTooLarge(fileSize(f.size ?? 0)) : t.fileGone}</div>
              </div>
              {f.state === 'copied' ? (
                <ButtonLink href={ticketFileUrl(data.id, f.ord)} download={f.name} icon="download" size="sm">
                  {t.download}
                </ButtonLink>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function ComplaintBody({ data }: { data: AdminTicketDto }) {
  return (
    <>
      <Card className="rise">
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>{t.comment}</h2>
          <p className={styles.pre}>{data.comment}</p>
        </div>
      </Card>
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
        <Conversation data={data} />
      </Card>
      <Files data={data} title={t.files} none={t.noFiles} />
    </>
  );
}

// A request: its subject as the heading of its text, and the files the employee attached — nothing of a conversation.
function RequestBody({ data }: { data: AdminTicketDto }) {
  return (
    <>
      <Card className="rise">
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>{data.subject}</h2>
          <p className={styles.pre}>{data.comment}</p>
        </div>
      </Card>
      <Files data={data} title={t.requestFiles} none={t.noRequestFiles} />
    </>
  );
}

export function TicketPage() {
  const { ticketId = '' } = useParams();
  const load = useCallback(() => ticket(ticketId), [ticketId]);
  const { state, reload } = useLoad(load);
  const [fresh, setFresh] = useState<AdminTicketDto | null>(null);
  const data = fresh ?? (state.status === 'ready' ? state.data : null);
  return (
    <div className={styles.stack}>
      <Link to="/admin/support" className={styles.note}>
        ← {t.back}
      </Link>
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {data ? (
        <>
          <PageHead title={`${t.title} ${t.number(data.id)}`} lead={lineOf(data)} actions={<Pill tone={STATUS_TONE[data.status]}>{t.status[data.status]}</Pill>} />
          {data.kind === 'request' ? <RequestBody data={data} /> : <ComplaintBody data={data} />}
          <Card className="rise">
            <Answer key={`${data.id}:${data.status}:${data.reply ?? ''}`} data={data} onSaved={setFresh} />
          </Card>
        </>
      ) : null}
    </div>
  );
}
