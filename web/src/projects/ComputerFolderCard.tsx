// «Папка на компьютере» on the project's page (spec, section 8.25): what it gives the agent and what it does not (nothing
// copied ahead, only while the page is open in this browser), the mode — «Только читать» or «Читать и записывать» with its
// warning («Запись в папку»), chosen before the folder and changed for a connected one by the browser's leave — and the
// state of the folder in words with what to press: confirm the access, the browser forbade editing, the folder is gone.
import { useState } from 'react';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { Card, Pill } from '../ui/Display.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useToast } from '../ui/Toast.tsx';
import type { FolderAccess, FolderMode } from './computer-folder.ts';
import styles from './projects.module.css';
import { useComputerFolder } from './use-computer-folder.ts';

const t = ru.computer;

function statusOf(access: FolderAccess, mode: FolderMode): { tone: 'ok' | 'warn' | 'bad'; text: string } {
  switch (access) {
    case 'granted':
      return { tone: 'ok', text: mode === 'readwrite' ? t.readyWrite : t.readyRead };
    case 'prompt':
      return { tone: 'warn', text: t.needsAllowShort };
    case 'denied':
      return { tone: 'bad', text: mode === 'readwrite' ? t.deniedWrite : t.denied };
    case 'missing':
      return { tone: 'bad', text: t.missing };
  }
}

export function ComputerFolderCard({ projectId, userId }: { projectId: string; userId: string }) {
  const state = useComputerFolder(projectId, userId);
  const toast = useToast();
  // The mode for a folder not connected yet: the picker asks the browser for its right at once.
  const [wanted, setWanted] = useState<FolderMode>('read');
  const [note, setNote] = useState<string | null>(null);
  const { folder, access } = state;
  const mode = state.mode ?? wanted;
  const writes = state.writes && folder?.kind !== 'files';

  async function chooseMode(next: FolderMode) {
    setNote(null);
    if (!folder) return setWanted(next);
    if (next === state.mode) return;
    if ((await state.setMode(next)) !== 'granted' && next === 'readwrite') setNote(t.writeRefused);
  }

  const status = folder && access ? statusOf(access, mode) : null;
  return (
    <Card className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{t.title}</h2>
        {folder ? null : (
          <Button icon="monitor" onClick={() => void state.choose(mode)}>
            {t.connect}
          </Button>
        )}
      </div>
      <p className={styles.lead}>{t.lead}</p>
      <p className={styles.lead}>{t.personal}</p>
      {!state.keeps ? <p className={styles.lead}>{t.tabOnly}</p> : null}
      <div role="radiogroup" aria-label={t.modes} className={styles.folderModes}>
        {(['read', 'readwrite'] as const).map((m) => (
          <label key={m} className={styles.folderMode}>
            <input type="radio" name={`folder-mode-${projectId}`} checked={mode === m} disabled={m === 'readwrite' && !writes} onChange={() => void chooseMode(m)} />
            <span className={styles.folderModeText}>
              <span className={styles.folderModeName}>{m === 'read' ? t.modeRead : t.modeWrite}</span>
              <span className={styles.folderModeHint}>{m === 'read' ? t.modeReadHint : t.modeWriteHint}</span>
            </span>
          </label>
        ))}
        {writes ? null : <p className={styles.folderModeNote}>{t.writeUnsupported}</p>}
        {mode === 'readwrite' ? (
          <p className={styles.folderRisk}>
            <Icon name="alert" size={14} />
            <span>{t.writeRisk}</span>
          </p>
        ) : null}
        {note ? <p className={styles.folderModeNote}>{note}</p> : null}
      </div>
      {folder && status ? (
        <>
          <div className={styles.computerRow}>
            <Icon name="monitor" size={18} className={styles.chipIconOn} />
            <span className={styles.computerName}>{folder.name}</span>
            <Pill tone={status.tone}>{status.text}</Pill>
            <div className={styles.computerActions}>
              {access === 'prompt' ? (
                <Button size="sm" variant="primary" onClick={() => void state.allow()}>
                  {t.allow}
                </Button>
              ) : null}
              {access === 'denied' && mode === 'readwrite' ? (
                <Button size="sm" variant="primary" onClick={() => void state.setMode('read')}>
                  {t.toReadOnly}
                </Button>
              ) : null}
              <Button size="sm" {...(access === 'missing' ? { variant: 'primary' as const } : {})} onClick={() => void state.choose(mode)}>
                {access === 'missing' ? t.chooseAgain : t.change}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void state.forget().then(() => toast(t.forgotten))}>
                {t.forget}
              </Button>
            </div>
          </div>
          {access === 'prompt' ? <p className={styles.folderModeNote}>{t.needsAllowHint}</p> : null}
          {access === 'denied' && mode === 'readwrite' ? <p className={styles.folderModeNote}>{t.deniedWriteHint}</p> : null}
        </>
      ) : null}
    </Card>
  );
}
