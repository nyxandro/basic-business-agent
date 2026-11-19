// The live block of a search of the internet (spec, section 8.30; decision of the owner 20.11): while the researcher
// works, the line says what it does now — the query it searches, the site it reads — with a clock, and under it the
// queries and the sites so far, each with its state. Done, it folds into «Поиск в интернете · 2 запроса · 3 источника
// · 1 мин 12 с» that unfolds the same list; after a reload the list comes from the result of the call.
import { WEB_RESEARCH_TOOL, webResearchResultSchema, webStepSchema, type WebStep } from '@bba/contracts';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Collapse } from '../ui/Collapse.tsx';
import { Icon } from '../ui/Icon.tsx';
import chat from './chat.module.css';
import { useUnfinished } from './call-progress.ts';
import { parseToolResult } from './tool-result.ts';
import { useWebCall } from './web-progress.ts';
import styles from './web-search.module.css';

const t = ru.chat.webSearch;
const TICK_MS = 1000;

interface Call {
  toolCallId: string;
  status: 'inProgress' | 'executing' | 'complete';
  parameters: unknown;
  result: string | undefined;
}

// A failure of web_research keeps its steps too (core/web/research.ts).
const traceSchema = z.object({ steps: z.array(webStepSchema) });
// A search kept before 20.11 has its sources only.
const keptSchema = webResearchResultSchema.partial({ steps: true, ms: true });

type Outcome =
  | { kind: 'running' }
  // The answer ended without the result of the call: «Стоп», or the answer broke off.
  | { kind: 'stopped' }
  | { kind: 'done'; steps: WebStep[]; queries: number | null; sources: number; ms: number | null }
  | { kind: 'failed'; code: string | null; steps: WebStep[] };

const hostOf = (address: string) => {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
};

// `underway` — the call has no result yet and is still being worked on (call-progress.ts).
function outcomeOf(call: Call, underway: boolean): Outcome {
  if (call.status !== 'complete' || call.result === undefined) return underway ? { kind: 'running' } : { kind: 'stopped' };
  const outcome = parseToolResult(call.result);
  if (outcome.kind === 'ok') {
    const kept = keptSchema.safeParse(outcome.value);
    if (!kept.success) return { kind: 'failed', code: null, steps: [] };
    const { steps, sources, ms } = kept.data;
    if (steps) return { kind: 'done', steps, queries: steps.filter((s) => s.kind === 'search').length, sources: sources.length, ms: ms ?? null };
    const pages = sources.map((s): WebStep => ({ kind: 'page', id: s.address, address: s.address, host: hostOf(s.address), title: s.title, state: 'done' }));
    return { kind: 'done', steps: pages, queries: null, sources: sources.length, ms: null };
  }
  if (outcome.kind === 'declined') return { kind: 'failed', code: null, steps: [] };
  // A failure is an object of JSON (parseToolResult), so it parses again.
  const trace = traceSchema.safeParse(JSON.parse(call.result));
  return { kind: 'failed', code: outcome.code, steps: trace.success ? trace.data.steps : [] };
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// What the researcher does now: the last step under way, else the start.
function nowText(steps: readonly WebStep[]): string {
  const running = steps.findLast((s) => s.state === 'running');
  if (running?.kind === 'search') return t.searching(running.query);
  if (running?.kind === 'page') return t.reading(running.host);
  return steps.length === 0 ? t.starting : t.thinking;
}

// A step of a call left unfinished is not under way any more.
const settled = (step: WebStep): WebStep => (step.state === 'running' ? { ...step, state: 'failed', code: undefined } : step);

// The state of a step, without a spinner: a step under way measures nothing to show (decision of the owner 20.11) — a
// still dot, then ✓ or ✗; a search that found nothing is no success.
function StepIcon({ step }: { step: WebStep }) {
  if (step.state === 'running') return <span className={styles.pending} aria-hidden="true" />;
  if (step.state === 'failed') return <Icon name="x" size={13} className={styles.bad} />;
  if (step.kind === 'search' && !step.found) return <Icon name="minus" size={13} className={styles.kind} />;
  return <Icon name="check" size={13} className={styles.ok} />;
}

function Steps({ steps }: { steps: readonly WebStep[] }) {
  const queries = steps.filter((s) => s.kind === 'search');
  const pages = steps.filter((s) => s.kind === 'page');
  return (
    <div className={styles.steps}>
      {queries.length > 0 ? (
        <section aria-label={t.queries}>
          <div className={styles.group}>{t.queries}</div>
          <ul className={styles.list}>
            {queries.map((q) => (
              <li key={q.id} className={styles.row}>
                <StepIcon step={q} />
                <Icon name="search" size={13} className={styles.kind} />
                <span className={styles.text}>{q.query}</span>
                <span className={styles.note}>{q.state === 'done' ? t.found(q.found ?? 0) : q.state === 'failed' ? t.searchFailed : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {pages.length > 0 ? (
        <section aria-label={t.sites}>
          <div className={styles.group}>{t.sites}</div>
          <ul className={styles.list}>
            {pages.map((p) => (
              <li key={p.id} className={styles.row}>
                <StepIcon step={p} />
                {p.state === 'done' ? (
                  <a className={cx(styles.text, styles.link)} href={p.address} target="_blank" rel="noopener noreferrer">
                    <span className={styles.host}>{p.host}</span>
                    {p.title ? <span className={styles.title}> — {p.title}</span> : null}
                  </a>
                ) : (
                  <span className={styles.text}>
                    <span className={styles.host}>{p.host}</span>
                  </span>
                )}
                <span className={styles.note}>{p.state === 'running' ? t.readingNote : p.state === 'failed' ? t.pageFailed(p.code ?? '') : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function WebSearch({ call }: { call: Call }) {
  const { steps: live, startedAt } = useWebCall(call.toolCallId);
  const unfinished = useUnfinished();
  const outcome = outcomeOf(call, unfinished({ name: WEB_RESEARCH_TOOL }) === 'running');
  const running = outcome.kind === 'running';
  // Folded: the line says what the search does now; the list opens only on a click (decision of the owner 20.11).
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [running]);

  // The result keeps the steps for good; until it comes, and for a call left unfinished, the live ones. A step
  // under way is so only while the search is.
  const kept = outcome.kind === 'done' || outcome.kind === 'failed' ? outcome.steps : [];
  const seen = kept.length > 0 ? kept : (live ?? []);
  const steps = running ? seen : seen.map(settled);
  const unfolds = steps.length > 0;
  const toggle = () => setOpen(!open);

  if (running) {
    return (
      <div className={styles.block}>
        <button type="button" className={cx(chat.toolLine, styles.head)} aria-expanded={unfolds ? open : undefined} onClick={unfolds ? toggle : undefined}>
          {/* A still magnifier, not a spinner: the light over the words and the clock say it works. */}
          <Icon name="search" size={15} />
          <span className={cx(chat.toolText, chat.shimmer)} role="status">
            {nowText(steps)}
          </span>
          <span className={styles.clock}>{clock(now - startedAt)}</span>
          {unfolds ? <Icon name="down" size={15} className={cx(chat.toolChevron, open && chat.toolChevronOpen)} /> : null}
        </button>
        <Collapse open={open && unfolds} className={chat.toolUnfold}>
          <Steps steps={steps} />
        </Collapse>
      </div>
    );
  }

  let summary: string;
  if (outcome.kind === 'done') summary = t.done(outcome.queries, outcome.sources, outcome.ms);
  else if (outcome.kind === 'stopped') summary = t.stopped;
  else summary = outcome.code ? `${t.failed} · ${outcome.code}` : t.failed;
  // «Стоп» is the person's own choice: drawn like a refused action, not like a failure.
  const icon = outcome.kind === 'done' ? 'check' : outcome.kind === 'stopped' ? 'x' : 'alert';
  return (
    <div className={styles.block}>
      <button type="button" className={cx(chat.toolLine, styles.head, outcome.kind === 'failed' && chat.toolFailed)} aria-expanded={unfolds ? open : undefined} onClick={toggle} disabled={!unfolds}>
        <Icon name={icon} size={15} />
        <span className={chat.toolText}>{summary}</span>
        {unfolds ? <Icon name="down" size={15} className={cx(chat.toolChevron, open && chat.toolChevronOpen)} /> : null}
      </button>
      <Collapse open={open && unfolds} className={chat.toolUnfold}>
        <Steps steps={steps} />
      </Collapse>
    </div>
  );
}
