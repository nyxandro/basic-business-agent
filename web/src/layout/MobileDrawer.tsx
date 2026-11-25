// The side panel of a phone (mockup «Чат на телефоне»): it slides in over a scrim from «Меню» in
// the header; a choice, the scrim and Esc close it, and the focus stays inside while it is open.
import { ru } from '../i18n/ru.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { useDialogFocus } from '../ui/dialog-focus.ts';
import { Sidebar, type SidebarProps } from './Sidebar.tsx';
import styles from '../shell/shell.module.css';

export function MobileDrawer({ open, onClose, ...sidebar }: Omit<SidebarProps, 'onNavigate' | 'topRight' | 'approvalsAsSheet' | 'scrollWhole'> & { open: boolean; onClose: () => void }) {
  const box = useDialogFocus(open, onClose);
  return (
    <>
      <button type="button" tabIndex={-1} aria-hidden="true" className={cx(styles.scrim, open && styles.scrimOpen)} onClick={onClose} />
      <div ref={box} role="dialog" aria-modal="true" aria-label={ru.shell.menu} aria-hidden={!open} inert={!open} className={cx(styles.drawer, open && styles.drawerOpen)}>
        <Sidebar {...sidebar} onNavigate={onClose} approvalsAsSheet scrollWhole topRight={<IconButton icon="x" label={ru.shell.closeMenu} className={styles.drawerClose} onClick={onClose} />} />
      </div>
    </>
  );
}
