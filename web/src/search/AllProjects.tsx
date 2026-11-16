// All the person's projects in the window of «Поиск» while no query is typed (decision of the owner
// 16.11), in the order of the side panel; «В проекте» keeps that one. On «Проекты» the list says
// when it is loading, did not load or is empty; on «Везде» it stands above the conversations
// and shows only projects that are there — a list that did not load is told by the filter's note.
import type { ProjectDto } from '@bba/contracts';
import { ru } from '../i18n/ru.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import type { LoadState } from '../ui/use-load.ts';
import { ProjectResult, projectPath, projectResultOf } from './ProjectResult.tsx';
import styles from './search.module.css';

export type ProjectsState = LoadState<ProjectDto[]>;

export function AllProjects({ state, projectId, quiet, onRetry, onPick }: { state: ProjectsState; projectId: string | null; quiet: boolean; onRetry: () => void; onPick: (path: string) => void }) {
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
    if (quiet) return null;
    return (
      <div className={styles.error}>
        <ErrorBanner title={ru.search.projectsFailed} error={state.error} onRetry={onRetry} />
      </div>
    );
  }
  const projects = projectId ? state.data.filter((p) => p.id === projectId) : state.data;
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
