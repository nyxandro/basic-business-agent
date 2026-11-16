// All the person's projects in the window of «Поиск» while no query is typed (decision of the owner
// 16.11), in the order of the side panel. On «Проекты» the list says when it is loading or empty;
// on «Везде» it stands above the conversations and says neither. A list that did not load is
// shown with «Повторить» on both: otherwise nothing would tell it.
import type { ProjectDto } from '@bba/contracts';
import { ru } from '../i18n/ru.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import type { LoadState } from '../ui/use-load.ts';
import { ProjectResult, projectPath, projectResultOf } from './ProjectResult.tsx';
import styles from './search.module.css';

export type ProjectsState = LoadState<ProjectDto[]>;

export function AllProjects({ state, quiet, onRetry, onPick }: { state: ProjectsState; quiet: boolean; onRetry: () => void; onPick: (path: string) => void }) {
  if (state.status === 'loading') {
    if (quiet) return null;
    return (
      <p className={styles.hint} role="status">
        <span className={styles.spin} />
        {ru.search.loadingProjects}
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div className={styles.error}>
        <ErrorBanner title={ru.search.projectsFailed} error={state.error} onRetry={onRetry} />
      </div>
    );
  }
  const projects = state.data;
  if (projects.length === 0) {
    if (quiet) return null;
    return (
      <div className={styles.nothing}>
        <div className={styles.nothingTitle}>{ru.search.projectsEmpty}</div>
      </div>
    );
  }
  return (
    <>
      <div className={styles.group}>{ru.search.projects}</div>
      {projects.map((p) => (
        <ProjectResult key={p.id} project={projectResultOf(p)} onOpen={() => onPick(projectPath(p.id))} />
      ))}
    </>
  );
}
