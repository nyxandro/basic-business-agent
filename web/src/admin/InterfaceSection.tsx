// «Интерфейс» (spec, section 8.17): how the chat looks for every employee. Since 16.11 the marks
// belong to the agents (decision of the owner); here — only whether the chat shows them. The switch
// saves at once; the admin's own chat changes at once (the session is read again), others' — when
// they next open the page.
import type { InterfaceAdminState } from '@bba/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { useMe, useSession } from '../auth/session.tsx';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Card, PageHead } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { Switch } from '../ui/Switch.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import styles from './interface.module.css';
import { Feedback, useAction } from './parts.tsx';
import { hasRight } from './sections.ts';
import section from './section.module.css';

const t = ru.admin.interface;

function ShowMarks({ initial }: { initial: InterfaceAdminState }) {
  const me = useMe();
  const [state, setState] = useState(initial);
  const { busy, error, run } = useAction();
  const { refresh } = useSession();
  async function change(showAgentMark: boolean) {
    await run(async () => {
      setState(await adminApi.saveInterface({ showAgentMark }));
      await refresh();
    });
  }
  return (
    <Card className={cx(styles.showCard, 'rise')}>
      <div className={styles.showRow}>
        <div className={styles.showText}>
          <div className={styles.showTitle}>{t.showTitle}</div>
          <div className={section.sub}>{state.showAgentMark ? t.showSub : t.showOff}</div>
        </div>
        <Switch size="lg" checked={state.showAgentMark} disabled={busy} label={t.showTitle} onChange={(on) => void change(on)} />
      </div>
      {hasRight(me, 'agents') ? (
        <Link to="/admin/agents" className={styles.showLink}>
          {t.toAgents}
        </Link>
      ) : null}
      <Feedback error={error} />
    </Card>
  );
}

export function InterfaceSection() {
  const { state, reload } = useLoad(adminApi.interfaceSettings, ['admin', 'interface']);
  return (
    <div className={cx(section.stack, styles.page)}>
      <PageHead title={t.title} lead={t.lead} />
      {state.status === 'loading' ? <Skeleton rows={2} /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? <ShowMarks initial={state.data} /> : null}
    </div>
  );
}
