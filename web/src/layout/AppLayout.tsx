// The frame of signed-in screens: the menu (spec, section 12) and the person's name.
import { NavLink, Outlet } from 'react-router';
import { useMe, useSession } from '../auth/session.tsx';
import { ru } from '../i18n/ru.ts';

export function AppLayout() {
  const me = useMe();
  const { signOut } = useSession();
  return (
    <div className="layout">
      <header className="topbar">
        <nav className="menu">
          <NavLink to="/" end>
            {ru.menu.agents}
          </NavLink>
        </nav>
        <div className="user">
          <span>{me.user.name}</span>
          <button type="button" className="link-button" onClick={() => void signOut()}>
            {ru.menu.signOut}
          </button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
