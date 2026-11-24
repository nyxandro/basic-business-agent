// The admin panel (mockup «Админка»): on a computer its own side panel — «Админка» and the
// organisation, the sections in groups, «Вернуться в чат», the person and the theme; on a phone a
// header with the way back and the sections as chips. Only the sections of the person's roles
// show; a section without the right sends to the start page with «Этот раздел вам недоступен». «Поддержка» carries a red
// counter of the tickets waiting for the support's answer (owner 24.11, F8–F9).
import type { NotificationsResponse } from '@bba/contracts';
import { useCallback, useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { useMe } from '../auth/session.tsx';
import { fetchCounts } from '../notifications/api.ts';
import { LiveNewsContext, useLiveChannel } from '../notifications/live.ts';
import { ru } from '../i18n/ru.ts';
import { usePresence } from '../notifications/presence.ts';
import { useMedia, WIDE_QUERY } from '../ui/use-media.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { Avatar } from '../ui/Display.tsx';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useTheme } from '../ui/theme/ThemeProvider.tsx';
import styles from './admin.module.css';
import { agentPageKey } from './AgentPage.tsx';
import { availableSections, canOpen, sectionByPath, type SectionDef } from './sections.ts';

export const FORBIDDEN_STATE = { adminForbidden: true } as const;

const BACK = 'Вернуться в чат';
const SUPPORT_PATH = 'support';
// More is «99+»: the counter keeps its size.
const COUNT_SHOWN_MAX = 99;

// The tickets of «Поддержка» waiting for its answer: with the presence of the page every 30 s, and at once when the server
// says there is news (a message of an employee, a colleague's answer) — for those who handle the support; the others keep
// no channel. `news` — how many times the server said so: the screens of «Поддержка» read their data again. A person in
// the admin panel is in the app: news is not pushed to their browser meanwhile (notifications spec, section 8).
function useSupportWaiting(handles: boolean): { waiting: number; news: number } {
  const [waiting, setWaiting] = useState(0);
  const [news, setNews] = useState(0);
  const apply = useCallback((counts: NotificationsResponse) => setWaiting(counts.supportWaiting ?? 0), []);
  usePresence(null, apply);
  useLiveChannel(() => {
    setNews((n) => n + 1);
    fetchCounts().then(apply, (error: unknown) => console.warn('support counter not refreshed', error));
  }, handles);
  return { waiting, news };
}

// The label of a section in the menu: «Поддержка» with its counter when tickets wait for an answer. A screen reader hears
// one line, «Поддержка, ждут ответа: 3»: the hidden part apart from the visible label would be read with a gap before
// the comma (a browser puts a space around an element taken out of the line).
function SectionLabel({ section, waiting, className }: { section: SectionDef; waiting: number; className: string | undefined }) {
  if (section.path !== SUPPORT_PATH || waiting === 0) return <span>{section.label}</span>;
  return (
    <>
      <span aria-hidden="true">{section.label}</span>
      <span className="visually-hidden">{`${section.label}${ru.feedback.support.menuWaiting(waiting)}`}</span>
      <span className={className} aria-hidden="true">
        {waiting > COUNT_SHOWN_MAX ? `${COUNT_SHOWN_MAX}+` : waiting}
      </span>
    </>
  );
}

function ThemeToggle({ plain }: { plain?: boolean }) {
  const { theme, setTheme } = useTheme();
  const dark = theme === 'dark';
  return <IconButton icon={dark ? 'sun' : 'moon'} label={dark ? 'Светлая тема' : 'Тёмная тема'} variant={plain ? 'ghost' : 'outline'} size={plain ? 'lg' : 'md'} onClick={() => setTheme(dark ? 'light' : 'dark')} />;
}

// The chip of the open section stays in sight when the row of chips is longer than the screen.
function useActiveChipInView(): (node: HTMLAnchorElement | null) => void {
  return useCallback((node: HTMLAnchorElement | null) => {
    if (node?.getAttribute('aria-current') === 'page') node.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, []);
}

function groupsOf(sections: SectionDef[]): { title: string; items: SectionDef[] }[] {
  const groups: { title: string; items: SectionDef[] }[] = [];
  for (const s of sections) {
    const last = groups.at(-1);
    if (last?.title === s.group) last.items.push(s);
    else groups.push({ title: s.group, items: [s] });
  }
  return groups;
}

function Side({ sections, waiting }: { sections: SectionDef[]; waiting: number }) {
  const me = useMe();
  return (
    <aside className={styles.side}>
      <div className={styles.brand}>
        <span className={styles.brandMark}>
          <Icon name="spark" size={16} />
        </span>
        <div className={styles.brandText}>
          <div className={styles.brandTitle}>Админка</div>
          <div className={styles.brandOrg}>{me.organisation.name}</div>
        </div>
      </div>
      <nav aria-label="Разделы админки" className={styles.nav}>
        {groupsOf(sections).map((g) => (
          <div key={g.title} className={styles.group}>
            <div className={styles.groupTitle}>{g.title}</div>
            {g.items.map((s) => (
              <NavLink key={s.path} to={`/admin/${s.path}`} className={({ isActive }) => cx(styles.navItem, isActive && styles.navItemOn)}>
                <Icon name={s.icon} size={16} />
                <SectionLabel section={s} waiting={waiting} className={styles.navCount} />
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className={styles.fill} />
      <Link to="/" className={styles.back}>
        <Icon name="back" size={16} />
        {BACK}
      </Link>
      <div className={styles.person}>
        <Avatar name={me.user.name} size={34} />
        <div className={styles.personText}>
          <div className={styles.personName}>{me.user.name}</div>
          <div className={styles.personRole}>{me.isSuperadmin ? 'Суперадминистратор' : 'Администратор'}</div>
        </div>
        <ThemeToggle />
      </div>
    </aside>
  );
}

function PhoneTop({ sections, waiting }: { sections: SectionDef[]; waiting: number }) {
  const keepInView = useActiveChipInView();
  return (
    <>
      <header className={styles.phoneHeader}>
        <Link to="/" className={styles.phoneBack} aria-label={BACK} title={BACK}>
          <Icon name="back" />
        </Link>
        <div className={styles.phoneTitle}>Админка</div>
        <ThemeToggle plain />
      </header>
      <nav aria-label="Разделы админки" className={cx(styles.chips, 'scroll-thin')}>
        {sections.map((s) => (
          <NavLink key={s.path} ref={keepInView} to={`/admin/${s.path}`} className={({ isActive }) => cx(styles.chip, isActive && styles.chipOn)}>
            <SectionLabel section={s} waiting={waiting} className={styles.chipCount} />
          </NavLink>
        ))}
      </nav>
    </>
  );
}

export function AdminLayout() {
  const me = useMe();
  const wide = useMedia(WIDE_QUERY);
  const sections = availableSections(me);
  const { pathname } = useLocation();
  const { waiting, news } = useSupportWaiting(sections.some((s) => s.path === SUPPORT_PATH));
  if (sections.length === 0) return <Navigate to="/" replace state={FORBIDDEN_STATE} />;
  return (
    <div className={styles.shell}>
      {wide ? <Side sections={sections} waiting={waiting} /> : <PhoneTop sections={sections} waiting={waiting} />}
      <main className={cx(styles.main, 'scroll-thin')}>
        {/* A new section starts from its top; the sections of one agent are one page. */}
        <div key={agentPageKey(pathname)} className={styles.content}>
          <ErrorBoundary>
            <LiveNewsContext value={news}>
              <Outlet />
            </LiveNewsContext>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}

export function AdminIndex() {
  const first = availableSections(useMe())[0];
  return first ? <Navigate to={`/admin/${first.path}`} replace /> : <Navigate to="/" replace state={FORBIDDEN_STATE} />;
}

export function RequireSection({ path, children }: { path: string; children: ReactNode }) {
  const me = useMe();
  return canOpen(me, sectionByPath(path)) ? children : <Navigate to="/" replace state={FORBIDDEN_STATE} />;
}
