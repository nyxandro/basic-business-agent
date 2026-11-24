// The folder of the person's computer in the input of a project's conversation (spec, section 8.25), next to
// the chip of the project: without one — a square button «Подключить папку с компьютера» (to read: writing is chosen
// with its warning in the project's settings); with one — its name and its mode, a pen for «Читать и записывать»; when
// the browser wants the access confirmed — «Разрешить доступ»; a folder gone — «Выбрать заново». The menu changes the
// folder and its mode. The agent's tools for the folder live here, while the conversation is open.
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

export function ComputerFolderChip({ projectId, userId, threadId }: { projectId: string; userId: string; threadId: string }) {
  const state = useComputerFolder(projectId, userId);
  const [open, setOpen] = useState(false);
  const toast = useToast();
  useComputerTools(state.folder, threadId);
  const { folder, access } = state;

  if (!folder) {
    return (
      <button type="button" className={cx(styles.chip, styles.chipBare)} aria-label={t.connectShort} title={t.connectShort} onClick={() => void state.choose('read')}>
        <Icon name="monitor" size={17} className={styles.chipIcon} />
      </button>
    );
  }
  const write = state.mode === 'readwrite';
  if (access !== 'granted') {
    const gone = access === 'missing';
    // The browser forbade editing the folder: it can still be read.
    const toReading = access === 'denied' && write;
    const action = gone ? t.chooseAgain : toReading ? t.modeRead : access === 'denied' ? t.deniedShort : t.allow;
    const title = gone ? t.missing : access === 'denied' ? (write ? t.deniedWrite : t.denied) : t.needsAllow;
    const act = () => (gone ? state.choose(state.mode ?? 'read') : toReading ? state.setMode('read') : state.allow());
    return (
      <button type="button" className={cx(styles.chip, styles.chipWarn, styles.folderAnchor)} title={title} onClick={() => void act()}>
        <Icon name="monitor" size={15} className={styles.chipIcon} />
        <span className={styles.chipName}>{folder.name}</span>
        <span className={styles.chipAction}>{action}</span>
      </button>
    );
  }
  const label = t.chipTitle(folder.name, write);
  const switchTo = write ? 'read' : 'readwrite';
  return (
    <MenuAnchor className={styles.folderAnchor}>
      <button type="button" className={cx(styles.chip, styles.chipOn)} aria-haspopup="menu" aria-expanded={open} title={label} aria-label={label} onClick={() => setOpen((o) => !o)}>
        <Icon name="monitor" size={15} className={styles.chipIconOn} />
        <span className={styles.chipName}>{folder.name}</span>
        {write ? <Icon name="edit" size={13} className={styles.chipIconOn} /> : null}
      </button>
      <Menu open={open} onClose={() => setOpen(false)} label={t.menu} placement="top-start" width={250}>
        <MenuItem
          icon="folder"
          onSelect={() => {
            setOpen(false);
            void state.choose(state.mode ?? 'read');
          }}
        >
          {t.change}
        </MenuItem>
        {state.writes && folder.kind === 'handle' ? (
          <MenuItem
            icon={write ? 'eye' : 'edit'}
            onSelect={() => {
              setOpen(false);
              void state.setMode(switchTo).then((answer) => {
                if (answer !== 'granted' && switchTo === 'readwrite') toast(t.writeRefused);
              });
            }}
          >
            {write ? t.modeRead : t.modeWrite}
          </MenuItem>
        ) : null}
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
