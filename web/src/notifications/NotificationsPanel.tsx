// The panel under the bell (docs/specs/[20.11.2026]-notifications.md, F3): «Ждут решения» — questions of background
// tasks with «Да» / «Нет», questions of conversations leading to their card, only while something waits — and
// «Уведомления» of 30 days with
// «Отметить все прочитанными» and, while this browser is not on, the block «Включите уведомления…». On a computer it
// hangs under the bell; on a phone it is a sheet (`compact`).
import type { NotificationItem, NotificationKind } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { fetchApprovals } from '../approvals/api.ts';
import { ApprovalLists } from '../approvals/ApprovalCards.tsx';
import { notificationTexts as t } from '../i18n/notifications.ts';
import { ru } from '../i18n/ru.ts';
import { useNotifications } from '../layout/notifications.tsx';
import { Button, cx, IconButton } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { whenLabel } from '../ui/format.ts';
import { Icon, type IconName } from '../ui/Icon.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { Segmented } from '../ui/Segmented.tsx';
import { useLoad } from '../ui/use-load.ts';
import { fetchList, markAllRead, markRead } from './api.ts';
import { PushPrompt } from './PushControls.tsx';
import styles from './notifications.module.css';

export type PanelTab = 'waiting' | 'list';

const KIND_ICON: Record<NotificationKind, IconName> = {
  approval_waiting: 'inbox',
  approval_expiring: 'clock',
  connection_broken: 'plug',
  task_result: 'check',
  task_failed: 'alert',
  project_shared: 'folderShared',
  limit_near: 'wallet',
  limit_exhausted: 'wallet',
  answer_ready: 'chat',
  answer_failed: 'alert',
};

function Waiting({ compact, onClose }: { compact: boolean; onClose: () => void }) {
  // «Да» and «Нет» act on what is shown: a question answered meanwhile must not come back from memory.
  const { state, reload } = useLoad(fetchApprovals);
  if (state.status === 'loading') return <DelayedBar />;
  if (state.status === 'error') return <ErrorBanner title={ru.approvals.loadFailed} error={state.error} onRetry={reload} />;
  return (
    <>
      {state.data.pending.length === 0 && state.data.failed.length === 0 ? <p className={styles.empty}>{t.waitingEmpty}</p> : <ApprovalLists data={state.data} compact onNavigate={onClose} />}
      {compact ? null : (
        <Link to="/approvals" className={styles.footLink} onClick={onClose}>
          {t.openAll}
        </Link>
      )}
    </>
  );
}

function Item({ item, onOpen }: { item: NotificationItem; onOpen: (item: NotificationItem) => void }) {
  return (
    <li>
      <button type="button" className={cx(styles.item, !item.read && styles.unread)} onClick={() => onOpen(item)}>
        <span className={styles.itemIcon}>
          <Icon name={KIND_ICON[item.kind]} size={16} />
        </span>
        <span className={styles.itemText}>
          <span className={styles.itemTitle}>{item.title}</span>
          {item.body ? <span className={styles.itemBody}>{item.body}</span> : null}
          <span className={styles.itemTime}>{whenLabel(item.createdAt)}</span>
        </span>
        {item.read ? null : <span className={styles.dot} aria-label={t.unreadMark} />}
      </button>
    </li>
  );
}

function List({ onClose }: { onClose: () => void }) {
  const { state, reload } = useLoad(fetchList);
  const { refresh } = useNotifications();
  const navigate = useNavigate();
  const [allRead, setAllRead] = useState(false);
  const open = useCallback(
    (item: NotificationItem) => {
      markRead(item.id).then(refresh, (error: unknown) => console.warn('notification not marked read', error));
      onClose();
      void navigate(item.link);
    },
    [navigate, onClose, refresh],
  );
  if (state.status === 'loading') return <DelayedBar />;
  if (state.status === 'error') return <ErrorBanner title={t.listFailed} error={state.error} onRetry={reload} />;
  const items = allRead ? state.data.items.map((i) => ({ ...i, read: true })) : state.data.items;
  return (
    <>
      {items.some((i) => !i.read) ? (
        <div className={styles.listHead}>
          <Button variant="ghost" size="sm" onClick={() => void markAllRead().then(() => (setAllRead(true), refresh()), (error: unknown) => console.warn('notifications not marked read', error))}>
            {t.readAll}
          </Button>
        </div>
      ) : null}
      {items.length === 0 ? (
        <p className={styles.empty}>{t.listEmpty}</p>
      ) : (
        <ul className={styles.items} aria-label={t.tabNotifications}>
          {items.map((item) => (
            <Item key={item.id} item={item} onOpen={open} />
          ))}
        </ul>
      )}
      <PushPrompt />
    </>
  );
}

export function NotificationsPanel({ compact, onClose }: { compact: boolean; onClose: () => void }) {
  const { counts, panel, openPanel } = useNotifications();
  const waiting = counts?.pendingApprovals ?? 0;
  const unread = counts?.unread ?? 0;
  // «Ждут решения» is there only while something waits (owner, 22.11: an empty tab is extra layout). Once shown, it stays
  // while the panel is open: answering the last question there keeps its «Выполнено» in sight.
  const [withWaiting, setWithWaiting] = useState(waiting > 0);
  if (waiting > 0 && !withWaiting) setWithWaiting(true);
  const [chosen, setChosen] = useState<PanelTab>(panel.tab);
  const tab: PanelTab = withWaiting ? chosen : 'list';
  const choose = (next: PanelTab) => {
    setChosen(next);
    openPanel(next);
  };
  return (
    <div className={cx(styles.panel, compact && styles.panelCompact)}>
      <div className={styles.head}>
        <h2 className={styles.title}>{t.bell}</h2>
        {compact ? <IconButton icon="x" label={ru.approvals.close} onClick={onClose} /> : null}
      </div>
      {withWaiting ? (
        <Segmented
          label={t.bell}
          value={tab}
          onChange={choose}
          options={[
            { value: 'waiting', label: waiting > 0 ? `${t.tabWaiting} · ${waiting}` : t.tabWaiting },
            { value: 'list', label: unread > 0 ? `${t.tabNotifications} · ${unread}` : t.tabNotifications },
          ]}
        />
      ) : null}
      <div className={cx(styles.body, !compact && 'scroll-thin')}>{tab === 'waiting' ? <Waiting compact={compact} onClose={onClose} /> : <List onClose={onClose} />}</div>
    </div>
  );
}
