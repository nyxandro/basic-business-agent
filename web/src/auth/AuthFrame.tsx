// The frame of the sign-in and password pages: the product's mark and a card in the middle of the
// screen, in the colours of the interface (light or dark as chosen).
import type { ReactNode } from 'react';
import { ru } from '../i18n/ru.ts';
import { Icon } from '../ui/Icon.tsx';
import styles from './auth.module.css';

export function AuthFrame({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <main className={styles.page}>
      <div className={`${styles.box} rise`}>
        <div className={styles.brand}>
          <span className={styles.mark}>
            <Icon name="spark" />
          </span>
          {ru.shell.brand}
        </div>
        <div className={styles.card}>
          <h1 className={styles.title}>{title}</h1>
          {lead ? <p className={styles.lead}>{lead}</p> : null}
          {children}
        </div>
      </div>
    </main>
  );
}
