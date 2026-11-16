// «Поиск» (spec, scenario 7; mockup): Ctrl+K or the button in the side panel. On a computer — a
// window with «Везде / Разговоры / Проекты», «В проекте», groups and «Найдено: N»; on a phone —
// the whole screen with project chips and «Отмена». A choice opens the conversation or the project.
// Until a query is typed it lists all the person's projects (AllProjects.tsx) and conversations,
// newest first (AllThreads.tsx), as the scope allows; «Ещё» under «Недавние» opens it on
// «Разговоры». It starts afresh each time it opens (a new `key`).
import type { SearchScope } from '@bba/contracts';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { asApiError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { threadPath } from '../layout/ThreadRow.tsx';
import { fetchProjects } from '../projects/api.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';
import { AllProjects, type ProjectsState } from './AllProjects.tsx';
import { AllThreads } from './AllThreads.tsx';
import { ProjectResult, projectPath } from './ProjectResult.tsx';
import { useSearch, type SearchState } from './use-search.ts';
import styles from './search.module.css';
import { ThreadResult } from './ThreadResult.tsx';

const SCOPES: { id: SearchScope; label: string }[] = [
  { id: 'all', label: ru.search.everywhere },
  { id: 'threads', label: ru.search.threads },
  { id: 'projects', label: ru.search.projects },
];

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" aria-pressed={on} className={cx(styles.chip, on && styles.chipOn)} onClick={onClick}>
      {children}
    </button>
  );
}

function Results({ state, projectsState, scope, projectId, wide, projectName, onRetry, onRetryProjects, onPick }: { state: SearchState; projectsState: ProjectsState; scope: SearchScope; projectId: string | null; wide: boolean; projectName: (id: string | null) => string; onRetry: () => void; onRetryProjects: () => void; onPick: (path: string) => void }) {
  if (state.status === 'idle') {
    const projects = scope === 'threads' ? null : <AllProjects state={projectsState} projectId={projectId} quiet={scope === 'all'} onRetry={onRetryProjects} onPick={onPick} />;
    if (scope === 'projects') return projects;
    return (
      <>
        {projects}
        <AllThreads key={projectId ?? ''} projectId={projectId} wide={wide} projectName={projectName} onPick={onPick} />
      </>
    );
  }
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
            <ProjectResult key={p.id} project={p} onOpen={() => onPick(projectPath(p.id))} />
          ))}
        </>
      ) : null}
      {threads.length > 0 ? (
        <>
          <div className={styles.group}>{ru.search.threads}</div>
          {threads.map((t) => (
            <ThreadResult key={t.id} thread={t} projectName={projectName(t.projectId)} wide={wide} onOpen={() => onPick(threadPath(t))} />
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

export function SearchDialog({ open, startScope, wide, onClose }: { open: boolean; startScope: SearchScope; wide: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<SearchScope>(startScope);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectsState, setProjectsState] = useState<ProjectsState>({ status: 'loading' });
  const [projectsAttempt, setProjectsAttempt] = useState(0);
  const { state, retry } = useSearch(open ? q : '', scope, projectId);
  const navigate = useNavigate();

  // The person's projects: the list before a query and the project filter; without them the
  // filter has only «Все проекты». Loaded only while the window is open.
  useEffect(() => {
    if (!open) return;
    let current = true;
    fetchProjects().then(
      (r) => {
        if (current) setProjectsState({ status: 'ready', data: r.projects });
      },
      (error: unknown) => {
        console.warn('projects for the search window not loaded', error);
        if (current) setProjectsState({ status: 'error', error: asApiError(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [open, projectsAttempt]);
  const projects = projectsState.status === 'ready' ? projectsState.data : [];
  const projectsFailed = projectsState.status === 'error';
  const retryProjects = () => {
    setProjectsState({ status: 'loading' });
    setProjectsAttempt((n) => n + 1);
  };

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
        <Results state={state} projectsState={projectsState} scope={scope} projectId={projectId} wide={wide} projectName={projectName} onRetry={retry} onRetryProjects={retryProjects} onPick={pick} />
      </div>
      {wide && footer ? <div className={styles.footer}>{footer}</div> : null}
    </Modal>
  );
}
