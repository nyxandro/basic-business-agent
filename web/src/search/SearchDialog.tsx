// «Поиск» (spec, scenario 7, sections 8.13 and 8.21; mockup): Ctrl+K or the button in the side panel.
// On a computer — a window with «Везде / Разговоры / Проекты / Файлы», groups and «Найдено: N»; on a
// phone — the whole screen with «Отмена». No project filter: the projects are in the list itself
// (decision of the owner 16.11). A conversation or a project opens in place; a document opens its
// window over the search (FileDialog.tsx).
// Until a query is typed it lists all the person's projects (AllProjects.tsx) and conversations,
// newest first (AllThreads.tsx), as the scope allows, and on «Файлы» the newest documents
// (RecentFiles.tsx); «Ещё» under «Недавние» opens it on «Разговоры». It starts afresh each time it
// opens (a new `key`). A project's pin puts it into the side panel or out of it (decision of the owner
// 17.11): the row stays where it is — one that jumped up would put another project's pin under a second
// click — and the panel loads its list once the server has the pin.
import type { ProjectDto, SearchFile, SearchScope } from '@bba/contracts';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { threadPath } from '../threads/ThreadRow.tsx';
import { fetchProjects, updateProject } from '../projects/api.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';
import { AllProjects, type ProjectsState } from './AllProjects.tsx';
import { AllThreads } from './AllThreads.tsx';
import { FileDialog } from './FileDialog.tsx';
import { FilesGroup } from './FileResult.tsx';
import { ProjectResult, projectPath, type ProjectPin } from './ProjectResult.tsx';
import { RecentFiles } from './RecentFiles.tsx';
import { useSearch, type SearchState } from './use-search.ts';
import styles from './search.module.css';
import { ThreadResult } from './ThreadResult.tsx';

const SCOPES: { id: SearchScope; label: string }[] = [
  { id: 'all', label: ru.search.everywhere },
  { id: 'threads', label: ru.search.threads },
  { id: 'projects', label: ru.search.projects },
  { id: 'files', label: ru.search.files },
];

const NO_FILES = { files: [], unreadable: [], more: false };

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" aria-pressed={on} className={cx(styles.chip, on && styles.chipOn)} onClick={onClick}>
      {children}
    </button>
  );
}

function Results({ state, projectsState, scope, wide, projectName, pinOf, onRetry, onRetryProjects, onPick, onOpenFile }: { state: SearchState; projectsState: ProjectsState; scope: SearchScope; wide: boolean; projectName: (id: string | null) => string; pinOf: (id: string) => ProjectPin | undefined; onRetry: () => void; onRetryProjects: () => void; onPick: (path: string) => void; onOpenFile: (file: SearchFile) => void }) {
  if (state.status === 'idle') {
    if (scope === 'files') return <RecentFiles wide={wide} projectName={projectName} onOpen={onOpenFile} />;
    const projects = scope === 'threads' ? null : <AllProjects state={projectsState} quiet={scope === 'all'} pinOf={pinOf} onRetry={onRetryProjects} onPick={onPick} />;
    if (scope === 'projects') return projects;
    return (
      <>
        {projects}
        <AllThreads wide={wide} projectName={projectName} onPick={onPick} />
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
  const projects = scope === 'all' || scope === 'projects' ? state.data.projects : [];
  const threads = scope === 'all' || scope === 'threads' ? state.data.threads : [];
  const files = scope === 'all' || scope === 'files' ? state.data.files : NO_FILES;
  if (projects.length + threads.length + files.files.length + files.unreadable.length === 0) {
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
            <ProjectResult key={p.id} project={p} pin={pinOf(p.id)} onOpen={() => onPick(projectPath(p.id))} />
          ))}
        </>
      ) : null}
      <FilesGroup found={files} projectName={projectName} wide={wide} onOpen={onOpenFile} />
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
  const shows = (part: SearchScope) => scope === 'all' || scope === part;
  const n = (shows('projects') ? state.data.projects.length : 0) + (shows('threads') ? state.data.threads.length : 0) + (shows('files') ? state.data.files.files.length : 0);
  return n === 0 ? ru.search.noMatches : ru.search.found(n);
}

export function SearchDialog({ open, startScope, wide, onClose, onProjectsChanged, onPinFailed }: { open: boolean; startScope: SearchScope; wide: boolean; onClose: () => void; onProjectsChanged: () => void; onPinFailed: (error: ApiRequestError) => void }) {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<SearchScope>(startScope);
  const [projectsState, setProjectsState] = useState<ProjectsState>({ status: 'loading' });
  const [projectsAttempt, setProjectsAttempt] = useState(0);
  const [openFile, setOpenFile] = useState<SearchFile | null>(null);
  const { state, retry } = useSearch(open ? q : '', scope);
  const navigate = useNavigate();

  // The person's projects: the list before a query and the names on the conversations' rows.
  // Loaded only while the window is open.
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
  const retryProjects = () => {
    setProjectsState({ status: 'loading' });
    setProjectsAttempt((n) => n + 1);
  };

  // Saves of pins go one after another, so the server ends with the last pin the person made.
  const pins = useRef<Promise<unknown>>(Promise.resolve());
  const [pinError, setPinError] = useState<ApiRequestError | null>(null);
  // The list of the server once no pin is being saved: it never brings back a pin under way.
  async function settledProjects(): Promise<ProjectDto[]> {
    for (;;) {
      const pending = pins.current;
      await pending;
      const { projects: list } = await fetchProjects();
      if (pins.current === pending) return list;
    }
  }
  function togglePin(project: ProjectDto) {
    const pinned = !project.pinned;
    setPinError(null);
    setProjectsState({ status: 'ready', data: projects.map((p) => (p.id === project.id ? { ...p, pinned } : p)) });
    const saved = pins.current.then(() => updateProject(project.id, { pinned }));
    pins.current = saved.catch(() => undefined);
    saved.then(onProjectsChanged, (raw: unknown) => {
      const error = asApiError(raw);
      setPinError(error);
      onPinFailed(error);
      settledProjects().then(
        (list) => setProjectsState({ status: 'ready', data: list }),
        (again: unknown) => setProjectsState({ status: 'error', error: asApiError(again) }),
      );
    });
  }
  // Only a project of the person's list is pinned: the list says whether it is pinned already.
  const pinOf = (id: string): ProjectPin | undefined => {
    const project = projects.find((p) => p.id === id);
    return project ? { pinned: project.pinned, onToggle: () => togglePin(project) } : undefined;
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
        </div>
      ) : null}
      <div className={cx(styles.results, !wide && styles.resultsPhone, 'scroll-thin')} aria-live="polite">
        {pinError ? (
          <div className={styles.error}>
            <ErrorBanner title={ru.projects.orderFailed} error={pinError} />
          </div>
        ) : null}
        <Results state={state} projectsState={projectsState} scope={scope} wide={wide} projectName={projectName} pinOf={pinOf} onRetry={retry} onRetryProjects={retryProjects} onPick={pick} onOpenFile={setOpenFile} />
      </div>
      {wide && footer ? <div className={styles.footer}>{footer}</div> : null}
      {openFile ? <FileDialog file={openFile} projectName={projectName(openFile.projectId)} onClose={() => setOpenFile(null)} /> : null}
    </Modal>
  );
}
