// «Интерфейс» (spec, section 8.17): how the chat looks for every employee and what it lets them do. Since 16.11 the marks
// belong to the agents (decision of the owner); here — only whether the chat shows them. Since 24.11 — whether the
// documents the agent made carry the heart of samples (docs/specs/[20.11.2026]-feedback-and-value.md, F6; off in a new
// installation). Each switch saves at once only its own; the admin's own chat changes at once (the session is read
// again), others' — when they next open the page.
import type { InterfaceAdminState, InterfaceChange } from '@bba/contracts';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMe, useSession } from '../auth/session.tsx';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Card, PageHead } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { Switch } from '../ui/Switch.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import styles from './interface.module.css';
import { Feedback, useAction } from '../ui/form-parts.tsx';
import { hasRight } from './sections.ts';
import section from './section.module.css';

const t = ru.admin.interface;

// One switch in its card: what it does when on or off, its own saving and its own error.
function SwitchCard({ title, on, sub, save, children }: { title: string; on: boolean; sub: string; save: (on: boolean) => Promise<void>; children?: ReactNode }) {
  const { busy, error, run } = useAction();
  return (
    <Card className={cx(styles.showCard, 'rise')}>
      <div className={styles.showRow}>
        <div className={styles.showText}>
          <div className={styles.showTitle}>{title}</div>
          <div className={section.sub}>{sub}</div>
        </div>
        <Switch size="lg" checked={on} disabled={busy} label={title} onChange={(next) => void run(() => save(next))} />
      </div>
      {children}
      <Feedback error={error} />
    </Card>
  );
}

function Settings({ initial }: { initial: InterfaceAdminState }) {
  const me = useMe();
  const [state, setState] = useState(initial);
  const { refresh } = useSession();
  // Only the switch saved takes the server's answer: answers of two switches pressed one after the other may come back in
  // the other order, and the older one must not turn the other switch back on the screen.
  async function save(change: InterfaceChange) {
    const saved = await adminApi.saveInterface(change);
    setState((now) => ({
      showAgentMark: change.showAgentMark === undefined ? now.showAgentMark : saved.showAgentMark,
      documentSamples: change.documentSamples === undefined ? now.documentSamples : saved.documentSamples,
    }));
    await refresh();
  }
  return (
    <>
      <SwitchCard title={t.showTitle} on={state.showAgentMark} sub={state.showAgentMark ? t.showSub : t.showOff} save={(showAgentMark) => save({ showAgentMark })}>
        {hasRight(me, 'agents') ? (
          <Link to="/admin/agents" className={styles.showLink}>
            {t.toAgents}
          </Link>
        ) : null}
      </SwitchCard>
      <SwitchCard title={t.samplesTitle} on={state.documentSamples} sub={state.documentSamples ? t.samplesSub : t.samplesOff} save={(documentSamples) => save({ documentSamples })} />
    </>
  );
}

export function InterfaceSection() {
  // A form starts from what it loads: loaded anew at every opening, never from memory (spec, section 8.22).
  const { state, reload } = useLoad(adminApi.interfaceSettings);
  return (
    <div className={cx(section.stack, styles.page)}>
      <PageHead title={t.title} lead={t.lead} />
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? <Settings initial={state.data} /> : null}
    </div>
  );
}
