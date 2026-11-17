// «Папка на компьютере» on the project's page (spec, section 8.25): what it gives the agent and what it does
// not (nothing copied ahead, only while the page is open in this browser), the chosen folder with its state —
// «Доступна агенту», «Разрешить доступ» after a restart of the browser — and «Выбрать другую», «Отключить».
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { Card, Pill } from '../ui/Display.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useToast } from '../ui/Toast.tsx';
import styles from './projects.module.css';
import { useComputerFolder } from './use-computer-folder.ts';

const t = ru.computer;

export function ComputerFolderCard({ projectId }: { projectId: string }) {
  const state = useComputerFolder(projectId);
  const toast = useToast();
  const { folder, access } = state;
  const status = access === 'granted' ? { tone: 'ok' as const, text: t.ready } : access === 'denied' ? { tone: 'bad' as const, text: t.denied } : { tone: 'warn' as const, text: t.needsAllow };
  return (
    <Card className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{t.title}</h2>
        {folder ? null : (
          <Button size="sm" icon="monitor" onClick={() => void state.choose()}>
            {t.connect}
          </Button>
        )}
      </div>
      <p className={styles.lead}>{t.lead}</p>
      {!state.keeps ? <p className={styles.lead}>{t.tabOnly}</p> : null}
      {folder ? (
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
            <Button size="sm" onClick={() => void state.choose()}>
              {t.change}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void state.forget().then(() => toast(t.forgotten))}>
              {t.forget}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
