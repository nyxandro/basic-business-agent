// The gear next to the person's name (mockup): «Моя память», «Мои расходы», «Подключения», «Уведомления», the
// theme and «Выйти». The count of connected systems is asked when the menu opens. The menu opens
// over the whole row of the person, so the parent puts both into one MenuAnchor.
import type { MyConnection, MyUsage } from '@bba/contracts';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '../auth/session.tsx';
import { notificationTexts } from '../i18n/notifications.ts';
import { ru } from '../i18n/ru.ts';
import { fetchConnections } from '../settings/api.ts';
import { IconButton } from '../ui/Button.tsx';
import { Menu, MenuItem, MenuSeparator, MenuTitle } from '../ui/Menu.tsx';
import { Segmented } from '../ui/Segmented.tsx';
import { useTheme } from '../ui/theme/ThemeProvider.tsx';
import { spentShare } from './LimitMeter.tsx';
import styles from './shell.module.css';

export function SettingsMenu({ usage, onNavigate }: { usage: MyUsage | null; onNavigate: () => void }) {
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState<MyConnection[] | null>(null);
  const { theme, setTheme } = useTheme();
  const { signOut } = useSession();
  const navigate = useNavigate();

  function toggle() {
    const next = !open;
    setOpen(next);
    // A hint only: without the answer the item shows no count.
    if (next) fetchConnections().then((r) => setConnections(r.connections), (error: unknown) => console.warn('connections not counted', error));
  }
  const go = (path: string) => () => {
    setOpen(false);
    onNavigate();
    void navigate(path);
  };
  const share = usage ? spentShare(usage) : null;
  const connected = connections?.filter((c) => c.status === 'connected').length;

  return (
    <>
      <IconButton icon="gear" label={ru.shell.settings} onClick={toggle} aria-haspopup="dialog" aria-expanded={open} />
      <Menu open={open} onClose={() => setOpen(false)} label={ru.shell.settings} role="dialog" placement="top-stretch">
        <MenuTitle>{ru.shell.settings}</MenuTitle>
        <MenuItem icon="brain" onSelect={go('/settings/memory')}>
          {ru.shell.memory}
        </MenuItem>
        <MenuItem icon="wallet" meta={share === null ? undefined : `${share}%`} onSelect={go('/settings/usage')}>
          {ru.shell.usage}
        </MenuItem>
        <MenuItem icon="plug" meta={connections && connections.length > 0 ? ru.shell.connectionsOf(connected ?? 0, connections.length) : undefined} onSelect={go('/settings/connections')}>
          {ru.shell.connections}
        </MenuItem>
        <MenuItem icon="bell" onSelect={go('/settings/notifications')}>
          {notificationTexts.settingsTitle}
        </MenuItem>
        <MenuItem icon="headset" onSelect={go('/settings/requests')}>
          {ru.feedback.requests.title}
        </MenuItem>
        <MenuSeparator />
        <div className={styles.themeBlock}>
          <div className={styles.themeLabel}>{ru.shell.theme}</div>
          <Segmented
            label={ru.shell.theme}
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: ru.shell.light, icon: 'sun' },
              { value: 'dark', label: ru.shell.dark, icon: 'moon' },
            ]}
          />
        </div>
        <MenuSeparator />
        <MenuItem icon="logout" onSelect={() => void signOut()}>
          {ru.shell.signOut}
        </MenuItem>
      </Menu>
    </>
  );
}
