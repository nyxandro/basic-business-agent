// «Настройки» (spec, section 12): «Моя память», «Мои расходы», «Подключения».
import { NavLink, Outlet } from 'react-router';
import { ru } from '../i18n/ru.ts';

export function SettingsLayout() {
  return (
    <section>
      <h1>{ru.settings.title}</h1>
      <nav className="submenu">
        <NavLink to="/settings/memory">{ru.settings.memory}</NavLink>
        <NavLink to="/settings/usage">{ru.settings.usage}</NavLink>
        <NavLink to="/settings/connections">{ru.settings.connections}</NavLink>
      </nav>
      <Outlet />
    </section>
  );
}
