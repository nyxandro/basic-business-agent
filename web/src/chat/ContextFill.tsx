// How full a conversation is (spec, section 8.34; decisions of the owner 25.11): a ring in the header of the chat,
// filled by the share of the size of the context of the model the last call took. Only the ring — the numbers are in
// the window it opens. From 70% it is amber and the window offers a new conversation, from 90% red.
import type { ThreadContextFill } from '@bba/contracts';
import { useState } from 'react';
import { largeCount } from '../i18n/format.ts';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { Menu, MenuAnchor } from '../ui/Menu.tsx';
import styles from './context-fill.module.css';

const HIGH_SHARE = 0.7;
const FULL_SHARE = 0.9;
const PANEL_WIDTH_PX = 300;
// The ring: a circle of this radius in a square of 20, its length taken as 100 so the share is the length drawn.
const RING_RADIUS = 8;
const RING_LENGTH = 100;

type Level = 'ok' | 'high' | 'full';

const levelOf = (share: number): Level => (share >= FULL_SHARE ? 'full' : share >= HIGH_SHARE ? 'high' : 'ok');

export function ContextFillButton({ fill, onNewConversation }: { fill: ThreadContextFill | null; onNewConversation: () => void }) {
  const [open, setOpen] = useState(false);
  if (!fill) return null;
  // The answer of the last call goes into the next request too, so the sum can pass the size: the ring stops full.
  const share = Math.min(fill.tokens / fill.limit, 1);
  // A conversation that has something never reads «0%».
  const percent = fill.tokens > 0 ? Math.max(1, Math.round(share * 100)) : 0;
  const level = levelOf(share);
  const t = ru.chat.contextFill;
  return (
    <MenuAnchor>
      <button
        type="button"
        className={styles.button}
        data-level={level}
        aria-label={t.label(percent)}
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
          <div className={styles.tokens}>{t.tokens(largeCount(fill.tokens), largeCount(fill.limit))}</div>
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
