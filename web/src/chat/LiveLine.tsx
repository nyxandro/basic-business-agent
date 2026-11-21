// The live line of the answer being written (decision of the owner 21.11): one place under the answer says what the agent
// does now — a turning ring and «Работаю» while nothing is under way; the name of the action in its place while one is,
// with how much of it the model has written (owner 20.11: only real progress); the search with a still magnifier, its
// clock and its list a click away (owner 20.11). Done, the action goes up into the stack of the answer above, and the line
// turns back to «Работаю» while the agent goes on. Every change of the line turns like the wheel of a date picker
// (ui/Ticker.tsx); the line itself grows in and folds away (AssistantMessage.tsx). It is the last line of the answer,
// beside the agent's mark from the first moment (decision of the owner 21.11; until then «Работаю» had no mark, 18.11).
import { WEB_RESEARCH_TOOL, type AgentSummary, type WebStep } from '@bba/contracts';
import { useState } from 'react';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Collapse } from '../ui/Collapse.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Ticker } from '../ui/Ticker.tsx';
import styles from './chat.module.css';
import live from './live-line.module.css';
import { toolSummary } from './tool-summary.ts';
import { argumentsOf, type ToolCall } from './turn-items.ts';
import { SearchSteps, useSearchNow } from './WebSearch.tsx';
import search from './web-search.module.css';

// `call` — the call the answer works on now, null while nothing is under way.
export function LiveLine({ call, agent }: { call: ToolCall | null; agent: Pick<AgentSummary, 'systems' | 'actions'> }) {
  const now = useSearchNow(call?.function.name === WEB_RESEARCH_TOOL ? call.id : null);
  // The list is open for the search it was opened for; the next search comes folded.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = now !== null && openFor === call?.id;
  const args = call ? argumentsOf(call) : null;
  const text = now ? now.text : call ? toolSummary(call.function.name, 'inProgress', undefined, agent, args).text : ru.chat.working;
  // While the model still writes what the action is to do (its arguments are not whole JSON yet): how much has come.
  const written = call && !now && args === null ? call.function.arguments.length : 0;
  const unfolds = now !== null && now.steps.length > 0;
  // The list of the search stays while it folds away when the search is done (ui/Collapse.tsx).
  const [steps, setSteps] = useState<readonly WebStep[]>([]);
  if (now && now.steps.length > 0 && now.steps !== steps) setSteps(now.steps);

  return (
    <div className={live.live}>
      <div className={live.liveHead}>
        {/* A screen reader says the words when they change, not the clock every second nor every piece of the count. */}
        <span className={live.liveNow} role="status" aria-label={text}>
          {/* The icon turns with the words: the whole line goes up into the stack and the next comes from below. */}
          <Ticker value={`${call?.id ?? ''}:${text}`} className={live.liveTicker}>
            {now ? <Icon name="search" size={16} className={live.liveIcon} /> : <span className={live.workingRing} aria-hidden="true" />}
            <span className={live.workingWord}>{text}</span>
          </Ticker>
        </span>
        {/* Outside the wheel: the count and the clock change all the time and must not roll the line. The space keeps
            the words apart for a screen reader; in the line the gap of the flex does it. */}
        {written > 0 ? (
          <>
            {' '}
            <span className={cx(styles.toolCount, styles.toolWritten)}>{ru.chat.written(written)}</span>
          </>
        ) : null}
        {now ? <span className={search.clock}>{now.clock}</span> : null}
        {unfolds ? <Icon name="down" size={15} className={cx(live.liveChevron, styles.toolChevron, open && styles.toolChevronOpen)} /> : null}
        {/* The whole line opens the list; a button of its own over it keeps the wheel inside from being drawn anew. */}
        {unfolds ? <button type="button" className={live.liveCover} aria-label={text} aria-expanded={open} onClick={() => setOpenFor(open ? null : (call?.id ?? null))} /> : null}
      </div>
      <Collapse open={open && unfolds} className={live.liveUnfold}>
        <SearchSteps steps={steps} />
      </Collapse>
    </div>
  );
}
