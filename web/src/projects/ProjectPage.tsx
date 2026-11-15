// /projects/:id (spec, scenario 6, section 7): the project's name, «Инструкции для агента», «Файлы
// проекта» and its conversations with «Новый разговор в проекте». Someone else's or a removed
// project is «Проект не найден.»
import type { AgentSummary, ProjectDto, ThreadSummaryDto } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { ChatHeaderBar } from '../layout/ChatHeader.tsx';
import { useShell } from '../layout/AppShell.tsx';
import { threadPath } from '../layout/ThreadRow.tsx';
import { Button } from '../ui/Button.tsx';
import { Card } from '../ui/Display.tsx';
import { ErrorBanner, Notice } from '../ui/ErrorBanner.tsx';
import { Input, TextArea } from '../ui/Field.tsx';
import { dateTime } from '../ui/format.ts';
import { Icon } from '../ui/Icon.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { Menu, MenuAnchor, MenuItem } from '../ui/Menu.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { useToast } from '../ui/Toast.tsx';
import { useLoad } from '../ui/use-load.ts';
import { deleteProject, fetchProject, fetchProjectFiles, fetchProjectThreads, updateProject } from './api.ts';
import { ProjectFiles } from './ProjectFiles.tsx';
import page from '../layout/page.module.css';
import styles from './projects.module.css';

function Title({ project, onSaved }: { project: ProjectDto; onSaved: (p: ProjectDto) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [error, setError] = useState<ApiRequestError | null>(null);
  async function save() {
    setError(null);
    try {
      onSaved(await updateProject(project.id, { name }));
      setEditing(false);
    } catch (raw) {
      setError(asApiError(raw));
    }
  }
  if (!editing) {
    return (
      <>
        <h1 className={styles.title}>{project.name}</h1>
        <Button variant="ghost" icon="edit" onClick={() => setEditing(true)}>
          {ru.projects.rename}
        </Button>
      </>
    );
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
        <Input aria-label={ru.projects.name} value={name} onChange={(e) => setName(e.target.value)} className={styles.titleInput} />
        <Button type="submit" variant="primary" disabled={!name.trim()}>
          {ru.projects.save}
        </Button>
        <Button variant="secondary" onClick={() => (setEditing(false), setName(project.name))}>
          {ru.projects.cancel}
        </Button>
      </div>
      {error ? <p className={styles.fieldError}>{error.message}</p> : null}
    </form>
  );
}

function Instructions({ project, onSaved }: { project: ProjectDto; onSaved: (p: ProjectDto) => void }) {
  const [text, setText] = useState(project.instructions);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await updateProject(project.id, { instructions: text }));
      toast(ru.projects.saved);
    } catch (raw) {
      setError(asApiError(raw));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{ru.projects.instructions}</h2>
      </div>
      <p className={styles.empty}>{ru.projects.instructionsHint}</p>
      <TextArea aria-label={ru.projects.instructions} rows={6} value={text} onChange={(e) => setText(e.target.value)} />
      {error ? <ErrorBanner error={error} /> : null}
      <div className={styles.actions}>
        <Button variant="primary" disabled={busy || text === project.instructions} onClick={() => void save()}>
          {ru.projects.save}
        </Button>
      </div>
    </Card>
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
  const load = useCallback(() => fetchProjectThreads(project.id), [project.id]);
  const { state, reload } = useLoad(load);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  return (
    <Card className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{ru.projects.threads}</h2>
        {agents.length > 0 ? <NewThread projectId={project.id} agents={agents} /> : null}
      </div>
      {state.status === 'loading' ? <Skeleton rows={2} /> : null}
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
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export function ProjectPage() {
  const { projectId } = useParams();
  if (!projectId) throw new Error('ProjectPage needs the :projectId route parameter');
  const load = useCallback(() => fetchProject(projectId), [projectId]);
  const { state, reload } = useLoad(load);
  const [saved, setSaved] = useState<ProjectDto | null>(null);
  const [removeError, setRemoveError] = useState<ApiRequestError | null>(null);
  const { agents, wide, openMenu, refreshProjects } = useShell();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();

  if (state.status === 'loading') return <Skeleton rows={4} />;
  if (state.status === 'error') {
    return state.error.code === 'APP_NOT_FOUND' ? <Notice>{ru.projects.notFound}</Notice> : <ErrorBanner title={ru.projects.loadFailed} error={state.error} onRetry={reload} />;
  }
  const project = saved?.id === projectId ? saved : state.data;
  const update = (p: ProjectDto) => {
    setSaved(p);
    refreshProjects();
  };

  async function remove() {
    setRemoveError(null);
    try {
      const { files } = await fetchProjectFiles(project.id);
      const yes = await confirm({ title: ru.projects.removeTitle(project.name), text: ru.projects.removeText(files.length), confirmLabel: ru.projects.remove, danger: true });
      if (!yes) return;
      await deleteProject(project.id);
    } catch (raw) {
      setRemoveError(asApiError(raw));
      return;
    }
    refreshProjects();
    toast(ru.projects.removed);
    void navigate('/', { replace: true });
  }

  return (
    <>
      {wide ? null : <ChatHeaderBar title={project.name} onOpenMenu={openMenu} />}
      <div className={`${page.scroll} scroll-thin`}>
        <div className={`${styles.page} rise`}>
          <div className={styles.titleRow}>
            <span className={styles.titleMark}>
              <Icon name="folder" />
            </span>
            <Title key={project.name} project={project} onSaved={update} />
            <Button variant="danger" icon="trash" onClick={() => void remove()}>
              {ru.projects.remove}
            </Button>
          </div>
          {removeError ? <ErrorBanner error={removeError} /> : null}
          {!project.instructions && project.threadCount === 0 ? <p className={styles.lead}>{ru.projects.empty}</p> : null}
          <Instructions key={project.id} project={project} onSaved={update} />
          <ProjectFiles projectId={project.id} />
          <Threads project={project} agents={agents ?? []} />
        </div>
      </div>
    </>
  );
}
