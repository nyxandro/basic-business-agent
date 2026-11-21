// /projects/:id (spec, scenario 6, sections 7, 8.12 and 8.20): the project's name and who it is open to, then the
// tabs (request of the owner 17.11): «Разговоры» — the person's conversations in it with «Новый разговор в проекте»,
// «Файлы» — «Файлы проекта», and the gear at their end — «Настройки проекта»: the instructions, the memory and the
// folder of the computer (ProjectSettings.tsx). The tab is in the address (`?tab=files|settings`). Anyone who sees
// the project pins it to their side panel from the title row (decision of the owner 17.11). Its creator
// renames it, sets who it is open to, archives it; a colleague reads the instructions and works with the files. An archived project is read only, by its creator, with
// «Вернуть из архива» and — 30 days on — «Удалить навсегда». A project the person does not see is
// «Проект недоступен…».
import type { AgentSummary, ProjectDto, ThreadSummaryDto } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { ChatHeaderBar } from '../layout/ChatHeader.tsx';
import { useShell } from '../layout/AppShell.tsx';
import { threadPath } from '../layout/ThreadRow.tsx';
import { ThreadStateMark } from '../layout/ThreadState.tsx';
import { useNotifications } from '../layout/notifications.tsx';
import { Button, cx, IconButton } from '../ui/Button.tsx';
import { Card } from '../ui/Display.tsx';
import { ErrorBanner, Notice } from '../ui/ErrorBanner.tsx';
import { Input } from '../ui/Field.tsx';
import { dateTime, fullDate } from '../ui/format.ts';
import { Icon } from '../ui/Icon.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { Menu, MenuAnchor, MenuItem } from '../ui/Menu.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { useToast } from '../ui/Toast.tsx';
import { useLoad } from '../ui/use-load.ts';
import { accessText } from './AccessPicker.tsx';
import { archiveProject, deleteProject, fetchProject, fetchProjectFiles, fetchProjectThreads, unarchiveProject, updateProject } from './api.ts';
import { AccessDialog } from './ProjectDialog.tsx';
import { ProjectFiles } from './ProjectFiles.tsx';
import { ProjectSettings } from './ProjectSettings.tsx';
import { projectKeys } from './queries.ts';
import page from '../layout/page.module.css';
import styles from './projects.module.css';

// A project is removed for good this long after it went into the archive (spec, section 8.20).
const PROJECT_ARCHIVE_MS = 30 * 24 * 60 * 60 * 1000;

// The name being changed; «Переименовать» is one of the icons of the title row.
function TitleForm({ project, onSaved, onCancel }: { project: ProjectDto; onSaved: (p: ProjectDto) => void; onCancel: () => void }) {
  const [name, setName] = useState(project.name);
  const [error, setError] = useState<ApiRequestError | null>(null);
  async function save() {
    setError(null);
    try {
      onSaved(await updateProject(project.id, { name }));
    } catch (raw) {
      setError(asApiError(raw));
    }
  }
  return (
    <form
      className={styles.titleInput}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className={styles.titleRow}>
        <Input aria-label={ru.projects.name} value={name} onChange={(e) => setName(e.target.value)} className={styles.titleInput} autoFocus />
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          {ru.projects.save}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {ru.projects.cancel}
        </Button>
      </div>
      {error ? <p className={styles.fieldError}>{error.message}</p> : null}
    </form>
  );
}

function NewThread({ projectId, agents }: { projectId: string; agents: AgentSummary[] }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const start = (agentId: string) => void navigate(`/agents/${encodeURIComponent(agentId)}?thread=${crypto.randomUUID()}&project=${encodeURIComponent(projectId)}`);
  if (agents.length === 1) {
    return (
      <Button variant="primary" icon="plus" onClick={() => start(agents[0]!.id)}>
        {ru.projects.newThread}
      </Button>
    );
  }
  return (
    <MenuAnchor>
      <Button variant="primary" icon="plus" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        {ru.projects.newThread}
      </Button>
      <Menu open={open} onClose={() => setOpen(false)} label={ru.projects.chooseAgent}>
        {agents.map((a) => (
          <MenuItem key={a.id} icon="bot" onSelect={() => start(a.id)}>
            {a.name}
          </MenuItem>
        ))}
      </Menu>
    </MenuAnchor>
  );
}

function Threads({ project, agents }: { project: ProjectDto; agents: AgentSummary[] }) {
  const canStart = agents.length > 0 && !project.archivedAt;
  // The same marks as in «Недавние» (owner, 22.11).
  const { threadStates } = useNotifications();
  const load = useCallback(() => fetchProjectThreads(project.id), [project.id]);
  const { state, reload } = useLoad(load, projectKeys.threads(project.id));
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  return (
    <Card className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{project.shared ? ru.projects.ownThreads : ru.projects.threads}</h2>
        {canStart ? <NewThread projectId={project.id} agents={agents} /> : null}
      </div>
      {project.shared ? <p className={styles.empty}>{ru.projects.ownThreadsHint}</p> : null}
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' && state.data.threads.length === 0 ? <p className={styles.empty}>{ru.projects.noThreads}</p> : null}
      {state.status === 'ready' && state.data.threads.length > 0 ? (
        <ul className={styles.rows}>
          {state.data.threads.map((t: ThreadSummaryDto) => (
            <li key={t.id} className={styles.row}>
              <Icon name="chat" size={16} />
              <span className={styles.rowMain}>
                <Link to={threadPath(t)} className={styles.rowName}>
                  {t.title}
                </Link>
                <span className={styles.rowMeta}>
                  {agentName(t.agentId)} · {dateTime(t.updatedAt)}
                </span>
              </span>
              <ThreadStateMark state={threadStates[t.id]} />
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

// Under the name: the creator's «Только вы» / «Открыт: …» with «Настроить доступ»; a colleague's «Открыл(а): …».
function AccessLine({ project, onEdit }: { project: ProjectDto; onEdit: () => void }) {
  if (project.role === 'member') {
    return (
      <div className={styles.accessLine}>
        <span>
          <Icon name="folderShared" size={15} />
          {ru.projects.openedBy(project.owner.name)}
        </span>
      </div>
    );
  }
  if (!project.access) return null;
  return (
    <div className={styles.accessLine}>
      <span>
        <Icon name={project.shared ? 'folderShared' : 'lock'} size={15} />
        {accessText(project.access)}
      </span>
      {project.archivedAt ? null : (
        <Button size="sm" variant="ghost" icon="users" onClick={onEdit}>
          {ru.projects.accessEdit}
        </Button>
      )}
    </div>
  );
}

// An archived project: why it is read only, «Вернуть из архива», and «Удалить навсегда» from its date.
function ArchivedBanner({ project, onBack, onDelete, busy }: { project: ProjectDto; onBack: () => void; onDelete: () => void; busy: boolean }) {
  // The moment the page was opened: «Удалить навсегда» waits for its date, a reload brings it on time.
  const [now] = useState(() => Date.now());
  const since = project.archivedAt!;
  const from = new Date(Date.parse(since) + PROJECT_ARCHIVE_MS).toISOString();
  const early = now < Date.parse(from);
  return (
    <div className={styles.banner} role="status">
      <Icon name="archive" size={18} />
      <p>{ru.projects.archivedBanner(fullDate(since))}</p>
      <Button size="sm" variant="primary" disabled={busy} onClick={onBack}>
        {ru.projects.unarchive}
      </Button>
      <Button size="sm" variant="danger" icon="trash" disabled={busy || early} title={early ? ru.projects.deleteFrom(fullDate(from)) : undefined} onClick={onDelete}>
        {ru.projects.deleteForever}
      </Button>
      {early ? <p className={styles.empty}>{ru.projects.deleteFrom(fullDate(from))}</p> : null}
    </div>
  );
}

type ProjectTab = 'threads' | 'files' | 'settings';

const tabOf = (value: string | null): ProjectTab => (value === 'files' || value === 'settings' ? value : 'threads');

// «Разговоры» and «Файлы»; the settings open from the gear of the title row (request of the owner 17.11). Links,
// not buttons: the tab is in the address, so a reload, «Назад» and a link keep it.
function ProjectTabs({ tab }: { tab: ProjectTab }) {
  const props = (to: 'threads' | 'files') => ({
    to: { search: to === 'threads' ? '' : `?tab=${to}` },
    'aria-current': tab === to ? ('page' as const) : undefined,
    className: cx(styles.tab, tab === to && styles.tabOn),
  });
  return (
    <nav aria-label={ru.projects.tabsLabel} className={styles.tabs}>
      <Link {...props('threads')}>{ru.projects.tabThreads}</Link>
      <Link {...props('files')}>{ru.projects.tabFiles}</Link>
    </nav>
  );
}

export function ProjectPage() {
  const { projectId } = useParams();
  if (!projectId) throw new Error('ProjectPage needs the :projectId route parameter');
  const [params, setParams] = useSearchParams();
  const tab = tabOf(params.get('tab'));
  const load = useCallback(() => fetchProject(projectId), [projectId]);
  const { state, reload } = useLoad(load, projectKeys.project(projectId));
  // What the page just saved, over the project it was loaded as: the project loaded again has it.
  const [saved, setSaved] = useState<{ over: ProjectDto; project: ProjectDto } | null>(null);
  const [actionError, setActionError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const [editAccess, setEditAccess] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const { agents, openMenu, refreshProjects, projectsKey } = useShell();
  const [seenKey, setSeenKey] = useState(projectsKey);
  if (seenKey !== projectsKey) {
    setSeenKey(projectsKey);
    reload();
  }
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();

  if (state.status === 'loading') return <DelayedBar />;
  if (state.status === 'error') {
    return state.error.code === 'APP_NOT_FOUND' ? <Notice>{ru.projects.notFound}</Notice> : <ErrorBanner title={ru.projects.loadFailed} error={state.error} onRetry={reload} />;
  }
  const loaded = state.data;
  const project = saved && saved.over === loaded ? saved.project : loaded;
  const update = (p: ProjectDto) => {
    setSaved({ over: loaded, project: p });
    refreshProjects();
  };

  async function act(work: () => Promise<unknown>): Promise<boolean> {
    setActionError(null);
    setBusy(true);
    try {
      await work();
      return true;
    } catch (raw) {
      setActionError(asApiError(raw));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // «В архив»: gone from everyone's «Проекты»; «Вернуть» in the notice brings it back.
  async function archive() {
    if (!(await act(() => archiveProject(project.id)))) return;
    refreshProjects();
    toast(ru.projects.archived(project.name), { label: ru.projects.undo, run: () => void unarchiveProject(project.id).then(refreshProjects, (raw: unknown) => setActionError(asApiError(raw))) });
    void navigate('/', { replace: true });
  }

  // The project goes into the side panel or out of it (decision of the owner 17.11): the panel loads again.
  async function pin() {
    let saved: ProjectDto | null = null;
    if (await act(async () => (saved = await updateProject(project.id, { pinned: !project.pinned })))) update(saved!);
  }

  async function unarchive() {
    if (await act(() => unarchiveProject(project.id))) {
      refreshProjects();
      reload();
    }
  }

  async function removeForever() {
    let files = 0;
    if (!(await act(async () => (files = (await fetchProjectFiles(project.id)).files.length)))) return;
    const yes = await confirm({ title: ru.projects.deleteForeverTitle(project.name), text: ru.projects.deleteForeverText(files), confirmLabel: ru.projects.deleteForever, danger: true });
    if (!yes || !(await act(() => deleteProject(project.id)))) return;
    refreshProjects();
    toast(ru.projects.deletedForever);
    void navigate('/', { replace: true });
  }

  const owner = project.role === 'owner';
  const archived = project.archivedAt !== null;

  return (
    <>
      <ChatHeaderBar title={project.name} onOpenMenu={openMenu} />
      <div className={`${page.scroll} scroll-thin`}>
        <div className={`${styles.page} rise`}>
          <div className={styles.titleRow}>
            <span className={styles.titleMark}>
              <Icon name={project.shared ? 'folderShared' : 'folder'} />
            </span>
            {renaming ? (
              <TitleForm
                project={project}
                onSaved={(p) => {
                  update(p);
                  setRenaming(false);
                }}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              <h1 className={styles.title}>{project.name}</h1>
            )}
            {/* Icons in a row (requests of the owner 17.11): «Закрепить в панели», «Переименовать», «В архив»,
                «Настройки проекта»; a colleague pins and opens the settings, an archived project has only the settings. */}
            <span className={styles.titleActions}>
              {!archived ? (
                <IconButton
                  icon="pin"
                  label={project.pinned ? ru.projects.unpinFromPanel : ru.projects.pinToPanel}
                  className={cx(project.pinned && styles.titleIconOn)}
                  disabled={busy}
                  onClick={() => void pin()}
                />
              ) : null}
              {owner && !archived && !renaming ? <IconButton icon="edit" label={ru.projects.rename} onClick={() => setRenaming(true)} /> : null}
              {owner && !archived ? <IconButton icon="archive" label={ru.projects.archive} disabled={busy} onClick={() => void archive()} /> : null}
              <IconButton icon="gear" label={ru.projects.settings} aria-pressed={tab === 'settings'} className={cx(tab === 'settings' && styles.titleIconOn)} onClick={() => setParams({ tab: 'settings' })} />
            </span>
          </div>
          <AccessLine project={project} onEdit={() => setEditAccess(true)} />
          {archived ? <ArchivedBanner project={project} busy={busy} onBack={() => void unarchive()} onDelete={() => void removeForever()} /> : null}
          {actionError ? <ErrorBanner error={actionError} /> : null}
          {owner && !archived && !project.instructions && project.threadCount === 0 ? <p className={styles.lead}>{ru.projects.empty}</p> : null}
          <ProjectTabs tab={tab} />
          {tab === 'threads' ? <Threads project={project} agents={agents ?? []} /> : null}
          {tab === 'files' ? <ProjectFiles projectId={project.id} readOnly={archived} shared={project.shared} /> : null}
          {tab === 'settings' ? <ProjectSettings project={project} onSaved={update} /> : null}
          <AccessDialog
            project={editAccess ? project : null}
            onClose={() => setEditAccess(false)}
            onSaved={(p) => {
              setEditAccess(false);
              update(p);
              toast(ru.projects.accessSaved);
            }}
          />
        </div>
      </div>
    </>
  );
}
