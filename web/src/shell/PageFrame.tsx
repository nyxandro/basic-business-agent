// A screen of the person's own pages (settings, «Ждёт подтверждения»): the header with the title and the bell (on a
// phone with «Меню» too), then the title, the lead and the content in an 820 px column (mockup).
import type { ReactNode } from 'react';
import { PageHead } from '../ui/Display.tsx';
import { useShell } from './shell-context.ts';
import { ChatHeaderBar } from './ChatHeader.tsx';
import styles from './page.module.css';

export function PageFrame({ title, lead, actions, children }: { title: string; lead?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const { openMenu } = useShell();
  return (
    <>
      <ChatHeaderBar title={title} onOpenMenu={openMenu} />
      <div className={`${styles.scroll} scroll-thin`}>
        <div className={styles.page}>
          <PageHead title={title} lead={lead} actions={actions} />
          <div className={styles.body}>{children}</div>
        </div>
      </div>
    </>
  );
}
