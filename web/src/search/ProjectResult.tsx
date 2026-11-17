// A project in the window of «Поиск»: its name, how many of the person's conversations it holds and,
// for a project a colleague opened to them, who that is. The same row for a found project and for
// the list shown before a query. Its pin puts the project into the side panel or out of it (decision
// of the owner 17.11): on hover and keyboard focus, on a touch screen always; a pinned one shows it always.
import type { ProjectDto, SearchResponse } from '@bba/contracts';
import { ru } from '../i18n/ru.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Marked } from './Marked.tsx';
import styles from './search.module.css';

export type ProjectResultData = SearchResponse['projects'][number];

// The same fields the server gives for a found project (core/search/search.ts).
export function projectResultOf(p: ProjectDto): ProjectResultData {
  return { id: p.id, name: p.name, nameMarks: [], threadCount: p.threadCount, shared: p.shared, ownerName: p.role === 'member' ? p.owner.name : null };
}

export const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;

export interface ProjectPin {
  pinned: boolean;
  onToggle: () => void;
}

export function ProjectResult({ project, pin, onOpen }: { project: ProjectResultData; pin: ProjectPin | undefined; onOpen: () => void }) {
  const row = (
    <button type="button" className={styles.result} onClick={onOpen}>
      <span className={cx(styles.tile, styles.tileProject)}>
        <Icon name={project.shared ? 'folderShared' : 'folder'} size={15} />
      </span>
      <span className={styles.resultMain}>
        <span className={styles.resultTitle}>
          <Marked text={project.name} marks={project.nameMarks} />
        </span>
        <span className={styles.meta}>
          {ru.search.threadCount(project.threadCount)}
          {project.ownerName ? ` · ${ru.projects.openedBy(project.ownerName)}` : ''}
        </span>
      </span>
      {/* The place of the pin, which lies over it: a button may not hold another one. */}
      {pin ? <span className={styles.pinPlace} /> : null}
      <Icon name="right" size={15} className={styles.chevron} />
    </button>
  );
  if (!pin) return row;
  return (
    <div className={cx(styles.pinRow, pin.pinned && styles.pinRowOn)}>
      {row}
      <IconButton icon="pin" size="sm" label={pin.pinned ? ru.projects.unpinOf(project.name) : ru.projects.pinOf(project.name)} className={styles.pin} onClick={pin.onToggle} />
    </div>
  );
}
