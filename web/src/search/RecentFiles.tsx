// The tab «Файлы» while no query is typed (decision of the owner 16.11): the newest documents of the person's
// folder and of the projects they see.
import type { SearchFile } from '@bba/contracts';
import { ru } from '../i18n/ru.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { useLoad } from '../ui/use-load.ts';
import { fetchRecentFiles } from './api.ts';
import { FilesGroup } from './FileResult.tsx';
import styles from './search.module.css';

export function RecentFiles({ wide, projectName, onOpen }: { wide: boolean; projectName: (id: string | null) => string; onOpen: (file: SearchFile) => void }) {
  const { state, reload } = useLoad(fetchRecentFiles, ['files', 'recent']);
  if (state.status === 'loading') {
    return (
      <p className={styles.hint} role="status">
        <span className={styles.spin} />
        {ru.search.loadingFiles}
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div className={styles.error}>
        <ErrorBanner title={ru.search.filesFailed} error={state.error} onRetry={reload} />
      </div>
    );
  }
  if (state.data.files.length === 0 && state.data.unreadable.length === 0) {
    return (
      <div className={styles.nothing}>
        <div className={styles.nothingTitle}>{ru.search.filesEmpty}</div>
      </div>
    );
  }
  return <FilesGroup found={state.data} projectName={projectName} wide={wide} onOpen={onOpen} />;
}
