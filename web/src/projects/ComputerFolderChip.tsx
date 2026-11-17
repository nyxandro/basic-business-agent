// The folder of the person's computer in the input of a project's conversation (spec, section 8.25), next to
// the chip of the project: without one — a square button «Подключить папку с компьютера»; with one — its
// name, and «Разрешить доступ» when the browser asks to confirm after a restart. The agent's tools for the
// folder live here, while the conversation is open.
import { useState } from 'react';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Menu, MenuAnchor, MenuItem } from '../ui/Menu.tsx';
import { useToast } from '../ui/Toast.tsx';
import { useComputerTools } from './computer-tools.ts';
import styles from './projects.module.css';
import { useComputerFolder } from './use-computer-folder.ts';

const t = ru.computer;

export function ComputerFolderChip({ projectId, threadId }: { projectId: string; threadId: string }) {
  const state = useComputerFolder(projectId);
  const [open, setOpen] = useState(false);
  const toast = useToast();
  useComputerTools(state.folder, threadId);
  const { folder, access } = state;

  if (!folder) {
    return (
      <button type="button" className={cx(styles.chip, styles.chipBare)} aria-label={t.connectShort} title={t.connectShort} onClick={() => void state.choose()}>
        <Icon name="monitor" size={17} className={styles.chipIcon} />
      </button>
    );
  }
  if (access !== 'granted') {
    return (
      <button type="button" className={cx(styles.chip, styles.chipWarn, styles.folderAnchor)} title={t.needsAllow} onClick={() => void state.allow()}>
        <Icon name="monitor" size={15} className={styles.chipIcon} />
        <span className={styles.chipName}>{folder.name}</span>
        <span className={styles.chipAction}>{t.allow}</span>
      </button>
    );
  }
  return (
    <MenuAnchor className={styles.folderAnchor}>
      <button type="button" className={cx(styles.chip, styles.chipOn)} aria-haspopup="menu" aria-expanded={open} title={t.chipTitle(folder.name)} aria-label={t.chipTitle(folder.name)} onClick={() => setOpen((o) => !o)}>
        <Icon name="monitor" size={15} className={styles.chipIconOn} />
        <span className={styles.chipName}>{folder.name}</span>
      </button>
      <Menu open={open} onClose={() => setOpen(false)} label={t.menu} placement="top-start" width={250}>
        <MenuItem
          icon="folder"
          onSelect={() => {
            setOpen(false);
            void state.choose();
          }}
        >
          {t.change}
        </MenuItem>
        <MenuItem
          icon="x"
          danger
          onSelect={() => {
            setOpen(false);
            void state.forget().then(() => toast(t.forgotten));
          }}
        >
          {t.forget}
        </MenuItem>
      </Menu>
    </MenuAnchor>
  );
}
