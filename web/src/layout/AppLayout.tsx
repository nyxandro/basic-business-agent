// The frame of signed-in screens: the menu (spec, section 12) and the person's name.
import { NavLink, Outlet, useLocation } from 'react-router';
import { availableSections } from '../admin/sections.ts';
import { useMe, useSession } from '../auth/session.tsx';
import { ru } from '../i18n/ru.ts';
import { NotificationsProvider, useNotifications } from './notifications.tsx';

function ApprovalsLink() {
  const { counts } = useNotifications();
  const waiting = counts?.pendingApprovals ?? 0;
  return (
    <NavLink to="/approvals">
      {ru.menu.approvals}
      {waiting > 0 ? <span className="badge">{waiting}</span> : null}
    </NavLink>
  );
}

// A section of the admin panel opened without its right lands here (spec, section 7).
function ForbiddenNotice() {
  const state = useLocation().state as { adminForbidden?: boolean } | null;
  if (!state?.adminForbidden) return null;
  return (
    <div className="banner banner-error" role="alert">
      <p>{ru.admin.forbidden}</p>
      <p className="banner-code">
        {ru.common.errorCode}: APP_ADMIN_FORBIDDEN
      </p>
    </div>
  );
}

export function AppLayout() {
  const me = useMe();
  const { signOut } = useSession();
  const hasAdmin = availableSections(me).length > 0;
  return (
    <NotificationsProvider>
    <div className="layout">
      <header className="topbar">
        <nav className="menu">
          <NavLink to="/" end>
            {ru.menu.agents}
          </NavLink>
          <ApprovalsLink />
          <NavLink to="/settings">{ru.menu.settings}</NavLink>
          {hasAdmin ? <NavLink to="/admin">{ru.menu.admin}</NavLink> : null}
        </nav>
        <div className="user">
          <span>{me.user.name}</span>
          <button type="button" className="link-button" onClick={() => void signOut()}>
            {ru.menu.signOut}
          </button>
        </div>
      </header>
      <main className="content">
        <ForbiddenNotice />
        <Outlet />
      </main>
    </div>
    </NotificationsProvider>
  );
}
