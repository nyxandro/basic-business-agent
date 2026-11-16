// A project in the window of «Поиск»: its name, how many of the person's conversations it holds and,
// for a project a colleague opened to them, who that is. The same row for a found project and for
// the list shown before a query.
import type { ProjectDto, SearchResponse } from '@bba/contracts';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import styles from './search.module.css';

export type ProjectResultData = SearchResponse['projects'][number];

// The same fields the server gives for a found project (core/search/search.ts).
export function projectResultOf(p: ProjectDto): ProjectResultData {
  return { id: p.id, name: p.name, threadCount: p.threadCount, shared: p.shared, ownerName: p.role === 'member' ? p.owner.name : null };
}

export const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;

export function ProjectResult({ project, onOpen }: { project: ProjectResultData; onOpen: () => void }) {
  return (
    <button type="button" className={styles.result} onClick={onOpen}>
      <span className={cx(styles.tile, styles.tileProject)}>
        <Icon name={project.shared ? 'folderShared' : 'folder'} size={15} />
      </span>
      <span className={styles.resultMain}>
        <span className={styles.resultTitle}>{project.name}</span>
        <span className={styles.meta}>
          {ru.search.threadCount(project.threadCount)}
          {project.ownerName ? ` · ${ru.projects.openedBy(project.ownerName)}` : ''}
        </span>
      </span>
      <Icon name="right" size={15} className={styles.chevron} />
    </button>
  );
}
