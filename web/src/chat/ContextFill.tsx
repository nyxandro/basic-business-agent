// How full a conversation is (spec, section 8.34; decisions of the owner 25.11): a ring in the header of the chat,
// filled by the share of the size of the context of the model the last call took. Only the ring — the numbers are in
// the window it opens. From 70% it is amber and the window offers a new conversation, from 90% red.
import type { ThreadContextFill } from '@bba/contracts';
import { useId, useState } from 'react';
import { contextFillTexts as t } from '../i18n/context-fill.ts';
import { largeCount } from '../i18n/format.ts';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { Menu, MenuAnchor } from '../ui/Menu.tsx';
import styles from './context-fill.module.css';

const HIGH_PERCENT = 70;
const FULL_PERCENT = 90;
const PANEL_WIDTH_PX = 300;
// The ring: a circle of this radius in a square of 20, its length taken as 100 so the share is the length drawn.
const RING_RADIUS = 8;
const RING_LENGTH = 100;

type Level = 'ok' | 'high' | 'full';

// By the percent shown: «70%» is amber, never the calm colour of 69.6%.
const levelOf = (percent: number): Level => (percent >= FULL_PERCENT ? 'full' : percent >= HIGH_PERCENT ? 'high' : 'ok');

export function ContextFillButton({ fill, onNewConversation }: { fill: ThreadContextFill | null; onNewConversation: () => void }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  // A ring that went away (a model without a size answered) does not come back open.
  if (!fill && open) setOpen(false);
  if (!fill) return null;
  // The answer of the last call goes into the next request too, so the sum can pass the size: the ring stops full.
  const share = Math.min(fill.tokens / fill.limit, 1);
  // A conversation that has something never reads «0%».
  const percent = fill.tokens > 0 ? Math.max(1, Math.round(share * 100)) : 0;
  const level = levelOf(percent);
  const tokens = t.tokens(largeCount(fill.tokens), largeCount(fill.limit));
  return (
    <MenuAnchor>
      <button
        type="button"
        className={styles.button}
        data-level={level}
        aria-label={t.label(percent)}
        aria-describedby={detailsId}
        title={t.label(percent)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg className={styles.ring} viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
          <circle className={styles.track} cx="10" cy="10" r={RING_RADIUS} pathLength={RING_LENGTH} />
          <circle className={styles.arc} cx="10" cy="10" r={RING_RADIUS} pathLength={RING_LENGTH} strokeDasharray={RING_LENGTH} strokeDashoffset={RING_LENGTH * (1 - share)} transform="rotate(-90 10 10)" />
        </svg>
      </button>
      {/* The numbers for a screen reader, with the ring itself: the window below 70% has nothing to take the focus. */}
      <span id={detailsId} className="visually-hidden">
        {fill.hidden ? `${tokens}. ${t.hidden}` : tokens}
      </span>
      {/* Over the page and kept inside the window: on a phone the ring stands too far left for the window under it. */}
      <Menu open={open} onClose={() => setOpen(false)} label={t.title} role="dialog" placement="bottom-end" width={PANEL_WIDTH_PX} floating>
        <div className={styles.panel} data-level={level}>
          <div className={styles.head}>
            <span className={styles.title}>{t.title}</span>
            <span className={styles.percent}>{`${percent}%`}</span>
          </div>
          <div className={styles.bar}>
            <div className={styles.barFill} style={{ width: `${share * 100}%` }} />
          </div>
          <div className={styles.tokens}>{tokens}</div>
          {fill.hidden ? <div className={styles.note}>{t.hidden}</div> : null}
          {level === 'ok' ? null : (
            <>
              <p className={styles.warning}>{t.high}</p>
              <Button
                variant="primary"
                size="sm"
                icon="plus"
                className={styles.action}
                onClick={() => {
                  setOpen(false);
                  onNewConversation();
                }}
              >
                {ru.chat.newThread}
              </Button>
            </>
          )}
        </div>
      </Menu>
    </MenuAnchor>
  );
}
