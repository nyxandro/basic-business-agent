// The admin panel (mockup «Админка»): on a computer its own side panel — «Админка» and the
// organisation, the sections in groups, «Вернуться в чат», the person and the theme; on a phone a
// header with the way back and the sections as chips. Only the sections of the person's roles
// show; a section without the right sends to the start page with «Этот раздел вам недоступен».
import { useCallback, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { useMe } from '../auth/session.tsx';
import { useMedia, WIDE_QUERY } from '../layout/use-media.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { Avatar } from '../ui/Display.tsx';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useTheme } from '../ui/theme/ThemeProvider.tsx';
import styles from './admin.module.css';
import { availableSections, canOpen, sectionByPath, type SectionDef } from './sections.ts';

export const FORBIDDEN_STATE = { adminForbidden: true } as const;

const BACK = 'Вернуться в чат';

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

function Side({ sections }: { sections: SectionDef[] }) {
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
                <span>{s.label}</span>
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

function PhoneTop({ sections }: { sections: SectionDef[] }) {
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
            {s.label}
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
  if (sections.length === 0) return <Navigate to="/" replace state={FORBIDDEN_STATE} />;
  return (
    <div className={styles.shell}>
      {wide ? <Side sections={sections} /> : <PhoneTop sections={sections} />}
      <main className={cx(styles.main, 'scroll-thin')}>
        {/* A new section starts from its top. */}
        <div key={pathname} className={styles.content}>
          <ErrorBoundary>
            <Outlet />
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
