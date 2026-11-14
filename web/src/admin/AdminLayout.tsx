// The admin panel: the sections the person's roles open; a section without the right sends the
// person to the start page with «Этот раздел вам недоступен» (spec, section 7).
import type { AdminSection } from '@bba/contracts';
import type { ReactNode } from 'react';
import { Navigate, NavLink, Outlet } from 'react-router';
import { useMe } from '../auth/session.tsx';
import { availableSections, canOpen } from './sections.ts';

export const FORBIDDEN_STATE = { adminForbidden: true } as const;

export function AdminLayout() {
  const me = useMe();
  const sections = availableSections(me);
  if (sections.length === 0) return <Navigate to="/" replace state={FORBIDDEN_STATE} />;
  return (
    <div className="admin-layout">
      <nav className="admin-menu">
        {sections.map((s) => (
          <NavLink key={s.id} to={`/admin/${s.path}`}>
            {s.label}
          </NavLink>
        ))}
      </nav>
      <section className="admin-main">
        <Outlet />
      </section>
    </div>
  );
}

export function AdminIndex() {
  const first = availableSections(useMe())[0];
  return first ? <Navigate to={`/admin/${first.path}`} replace /> : <Navigate to="/" replace state={FORBIDDEN_STATE} />;
}

export function RequireSection({ section, children }: { section: AdminSection; children: ReactNode }) {
  const me = useMe();
  return canOpen(me, section) ? children : <Navigate to="/" replace state={FORBIDDEN_STATE} />;
}
