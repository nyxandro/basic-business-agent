// /projects/archive (spec, section 8.20): the creator's archived projects — when each went there,
// «Вернуть», and «Удалить навсегда» from 30 days on (before that the button waits, with its date).
import type { ArchivedProjectDto } from '@bba/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { ChatHeaderBar } from '../layout/ChatHeader.tsx';
import { useShell } from '../layout/AppShell.tsx';
import page from '../layout/page.module.css';
import { Button } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { fullDate } from '../ui/format.ts';
import { Icon } from '../ui/Icon.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useToast } from '../ui/Toast.tsx';
import { useLoad } from '../ui/use-load.ts';
import { deleteProject, fetchArchive, unarchiveProject } from './api.ts';
import { projectPath } from './ProjectRow.tsx';
import styles from './projects.module.css';

export function ArchivePage() {
  const { state, reload } = useLoad(fetchArchive);
  const { wide, openMenu, refreshProjects, projectsKey } = useShell();
  const [seenKey, setSeenKey] = useState(projectsKey);
  if (seenKey !== projectsKey) {
    setSeenKey(projectsKey);
    reload();
  }
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The moment the page was opened: «Удалить навсегда» waits for its date.
  const [now] = useState(() => Date.now());
  const confirm = useConfirm();
  const toast = useToast();

  async function act(id: string, work: () => Promise<unknown>, done: string) {
    setBusy(id);
    setError(null);
    try {
      await work();
      toast(done);
      refreshProjects();
    } catch (raw) {
      setError(asApiError(raw));
    } finally {
      setBusy(null);
    }
  }

  async function remove(p: ArchivedProjectDto) {
    const yes = await confirm({ title: ru.projects.deleteForeverTitle(p.name), text: ru.projects.deleteForeverText(p.files), confirmLabel: ru.projects.deleteForever, danger: true });
    if (yes) await act(p.id, () => deleteProject(p.id), ru.projects.deletedForever);
  }

  return (
    <>
      {wide ? null : <ChatHeaderBar title={ru.projects.archiveTitle} onOpenMenu={openMenu} />}
      <div className={`${page.scroll} scroll-thin`}>
        <div className={`${styles.page} rise`}>
          <div className={styles.titleRow}>
            <span className={styles.titleMark}>
              <Icon name="archive" />
            </span>
            <h1 className={styles.title}>{ru.projects.archiveTitle}</h1>
          </div>
          {error ? <ErrorBanner error={error} /> : null}
          <Card className={styles.section}>
            {state.status === 'loading' ? <Skeleton rows={3} /> : null}
            {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
            {state.status === 'ready' && state.data.projects.length === 0 ? <p className={styles.empty}>{ru.projects.archiveEmpty}</p> : null}
            {state.status === 'ready' && state.data.projects.length > 0 ? (
              <ul className={styles.rows}>
                {state.data.projects.map((p) => {
                  const early = now < Date.parse(p.deletableFrom);
                  return (
                    <li key={p.id} className={styles.row}>
                      <Icon name={p.shared ? 'folderShared' : 'folder'} size={18} />
                      <span className={styles.rowMain}>
                        <Link to={projectPath(p.id)} className={styles.rowName}>
                          {p.name}
                        </Link>
                        <span className={styles.rowMeta}>
                          {ru.projects.archivedSince(fullDate(p.archivedAt))} · {ru.projects.filesCount(p.files)}
                          {early ? ` · ${ru.projects.deleteFrom(fullDate(p.deletableFrom))}` : ''}
                        </span>
                      </span>
                      <Button size="sm" disabled={busy !== null} onClick={() => void act(p.id, () => unarchiveProject(p.id), ru.projects.restored)}>
                        {ru.projects.undo}
                      </Button>
                      <Button size="sm" variant="danger" icon="trash" disabled={busy !== null || early} onClick={() => void remove(p)}>
                        {ru.projects.deleteForever}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </Card>
        </div>
      </div>
    </>
  );
}
