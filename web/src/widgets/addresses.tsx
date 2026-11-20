// The addresses a widget may use (spec, section 8.31): a picture only from our own server (decision of the owner
// 19.11, F36) — another site's picture is a link to open; a button or an action opens only an address of the web or
// of mail, as CopilotKit's own components do.
import type { ReactNode } from 'react';
import { ru } from '../i18n/ru.ts';
import styles from './widgets.module.css';

export const ownAddress = (url: string): boolean => url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\');

export const safeHref = (href: unknown): string | null => (typeof href === 'string' && /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : null);

export function ForeignPicture({ url }: { url: string }): ReactNode {
  let shown = url;
  try {
    const parsed = new URL(url);
    shown = `${parsed.host}${parsed.pathname}`;
  } catch {
    // Not an address at all: shown as written.
  }
  const safe = /^https?:\/\//.test(url);
  return safe ? (
    <a className={styles.picture} href={url} target="_blank" rel="noopener noreferrer">
      {ru.widgets.picture(shown)}
    </a>
  ) : (
    <span className={styles.picture}>{ru.widgets.picture(shown)}</span>
  );
}
