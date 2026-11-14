// «Поиск» (spec, scenario 7; mockup): Ctrl+K or the button in the side panel. On a computer — a
// window with «Везде / Разговоры / Проекты», «В проекте», groups and «Найдено: N»; on a phone —
// the whole screen with project chips and «Отмена». A choice opens the conversation or the project.
import type { ProjectDto, SearchResponse, SearchScope } from '@bba/contracts';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ru } from '../i18n/ru.ts';
import { threadPath } from '../layout/RecentThreads.tsx';
import { fetchProjects } from '../projects/api.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dayLabel } from '../ui/format.ts';
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';
import { useSearch, type SearchState } from './use-search.ts';
import styles from './search.module.css';

const SCOPES: { id: SearchScope; label: string }[] = [
  { id: 'all', label: ru.search.everywhere },
  { id: 'threads', label: ru.search.threads },
  { id: 'projects', label: ru.search.projects },
];

type Thread = SearchResponse['threads'][number];

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" aria-pressed={on} className={cx(styles.chip, on && styles.chipOn)} onClick={onClick}>
      {children}
    </button>
  );
}

function ThreadRow({ thread, projectName, wide, onOpen }: { thread: Thread; projectName: string; wide: boolean; onOpen: () => void }) {
  const when = dayLabel(thread.updatedAt);
  return (
    <button type="button" className={styles.result} onClick={onOpen}>
      <span className={styles.tile}>
        <Icon name="chat" size={15} />
      </span>
      <span className={styles.resultMain}>
        <span className={styles.resultHead}>
          <span className={styles.resultTitle}>{thread.title}</span>
          {wide ? <span className={styles.when}>{when}</span> : null}
        </span>
        {thread.snippet ? <span className={styles.snippet}>{thread.snippet}</span> : null}
        <span className={styles.pill}>
          {wide ? <Icon name="folder" size={12} /> : null}
          <span>{projectName}</span>
          {wide ? null : <span>· {when}</span>}
        </span>
      </span>
    </button>
  );
}

function Results({ state, scope, wide, projectName, onRetry, onPick }: { state: SearchState; scope: SearchScope; wide: boolean; projectName: (id: string | null) => string; onRetry: () => void; onPick: (path: string) => void }) {
  if (state.status === 'idle') return <p className={styles.hint}>{ru.search.start}</p>;
  if (state.status === 'loading') {
    return (
      <p className={styles.hint} role="status">
        <span className={styles.spin} />
        {ru.search.searching}
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div className={styles.error}>
        <ErrorBanner error={state.error} onRetry={onRetry} />
      </div>
    );
  }
  const projects = scope === 'threads' ? [] : state.data.projects;
  const threads = scope === 'projects' ? [] : state.data.threads;
  if (projects.length + threads.length === 0) {
    return (
      <div className={styles.nothing}>
        <div className={styles.nothingTitle}>{ru.search.nothing}</div>
        <div>{ru.search.nothingHint}</div>
      </div>
    );
  }
  return (
    <>
      {projects.length > 0 ? (
        <>
          <div className={styles.group}>{ru.search.projects}</div>
          {projects.map((p) => (
            <button key={p.id} type="button" className={styles.result} onClick={() => onPick(`/projects/${encodeURIComponent(p.id)}`)}>
              <span className={cx(styles.tile, styles.tileProject)}>
                <Icon name="folder" size={15} />
              </span>
              <span className={styles.resultMain}>
                <span className={styles.resultTitle}>{p.name}</span>
                <span className={styles.meta}>{ru.search.threadCount(p.threadCount)}</span>
              </span>
              <Icon name="right" size={15} className={styles.chevron} />
            </button>
          ))}
        </>
      ) : null}
      {threads.length > 0 ? (
        <>
          <div className={styles.group}>{ru.search.threads}</div>
          {threads.map((t) => (
            <ThreadRow key={t.id} thread={t} projectName={projectName(t.projectId)} wide={wide} onOpen={() => onPick(threadPath(t))} />
          ))}
        </>
      ) : null}
    </>
  );
}

function count(state: SearchState, scope: SearchScope): string | null {
  if (state.status !== 'ready') return null;
  const n = (scope === 'threads' ? 0 : state.data.projects.length) + (scope === 'projects' ? 0 : state.data.threads.length);
  return n === 0 ? ru.search.noMatches : ru.search.found(n);
}

export function SearchDialog({ open, wide, onClose }: { open: boolean; wide: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<SearchScope>('all');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [projectsFailed, setProjectsFailed] = useState(false);
  const { state, retry } = useSearch(open ? q : '', scope, projectId);
  const navigate = useNavigate();

  // The project filter lists the person's projects; without them the filter has only «Все проекты».
  useEffect(() => {
    if (!open) return;
    let current = true;
    fetchProjects().then(
      (r) => {
        if (!current) return;
        setProjects(r.projects);
        setProjectsFailed(false);
      },
      (error: unknown) => {
        console.warn('projects for the search filter not loaded', error);
        if (current) setProjectsFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [open]);

  const close = () => {
    setQ('');
    onClose();
  };
  const pick = (path: string) => {
    close();
    void navigate(path);
  };
  const projectName = (id: string | null) => (id ? (projects.find((p) => p.id === id)?.name ?? ru.projects.title) : ru.projects.none);
  const footer = count(state, scope);

  return (
    <Modal open={open} onClose={close} label={ru.search.open} full={!wide}>
      <div className={cx(styles.head, !wide && styles.headPhone)}>
        <Icon name="search" className={styles.headIcon} />
        {/* The window exists to type a query: the field takes the focus when it opens. */}
        <input className={styles.input} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={wide ? ru.search.placeholder : ru.search.placeholderPhone} aria-label={ru.search.label} />
        {wide ? (
          <IconButton icon="x" label={ru.search.close} onClick={close} />
        ) : (
          <button type="button" className={styles.cancel} onClick={close}>
            {ru.search.cancel}
          </button>
        )}
      </div>
      {wide ? (
        <div className={styles.filters}>
          {SCOPES.map((s) => (
            <Chip key={s.id} on={scope === s.id} onClick={() => setScope(s.id)}>
              {s.label}
            </Chip>
          ))}
          <span className={styles.fill} />
          {projectsFailed ? <span className={styles.filterProblem}>{ru.search.projectsFailed}</span> : null}
          <label className={styles.selectLabel}>
            {ru.search.inProject}
            <select className={styles.select} value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value || null)}>
              <option value="">{ru.search.allProjects}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <div className={cx(styles.filters, styles.filtersPhone, 'scroll-thin')} aria-label={ru.search.inProject} role="group">
          <Chip on={projectId === null} onClick={() => setProjectId(null)}>
            {ru.search.allProjects}
          </Chip>
          {projects.map((p) => (
            <Chip key={p.id} on={projectId === p.id} onClick={() => setProjectId(p.id)}>
              {p.name}
            </Chip>
          ))}
          {projectsFailed ? <span className={styles.filterProblem}>{ru.search.projectsFailed}</span> : null}
        </div>
      )}
      <div className={cx(styles.results, !wide && styles.resultsPhone, 'scroll-thin')} aria-live="polite">
        <Results state={state} scope={scope} wide={wide} projectName={projectName} onRetry={retry} onPick={pick} />
      </div>
      {wide && footer ? <div className={styles.footer}>{footer}</div> : null}
    </Modal>
  );
}
