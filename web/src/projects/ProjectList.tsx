// «Проекты» of the side panel (spec, scenario 6; mockup): «+» opens a field, Enter creates the
// project and opens its page; each project with the number of its conversations.
import type { ProjectDto } from '@bba/contracts';
import { useCallback, useState, type KeyboardEvent } from 'react';
import { Link, useMatch, useNavigate } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useLoad } from '../ui/use-load.ts';
import shell from '../layout/shell.module.css';
import { createProject, fetchProjects } from './api.ts';
import styles from './projects.module.css';

function NewProject({ onDone }: { onDone: (project: ProjectDto | null) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await createProject(name.trim()));
    } catch (raw) {
      setError(asApiError(raw));
      setBusy(false);
    }
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void create();
    if (e.key === 'Escape') onDone(null);
  };
  return (
    <>
      <div className={styles.newProject}>
        <Icon name="folder" size={15} />
        {/* The field opens on the person's «+»: focusing it is what they asked for. */}
        <input className={styles.newInput} autoFocus value={name} placeholder={ru.projects.namePlaceholder} aria-label={ru.projects.name} onChange={(e) => setName(e.target.value)} onKeyDown={onKey} onBlur={() => !name.trim() && onDone(null)} />
        <IconButton icon="check" variant="primary" size="sm" label={ru.projects.create} onClick={() => void create()} disabled={!name.trim() || busy} />
      </div>
      {error ? <p className={styles.fieldError}>{error.message}</p> : null}
    </>
  );
}

export function ProjectList({ refreshKey, chatProjectId, onNavigate, onChanged }: { refreshKey: number; chatProjectId: string | null; onNavigate: () => void; onChanged: () => void }) {
  const load = useCallback(() => fetchProjects(), []);
  const { state, reload } = useLoad(load);
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();
  const page = useMatch('/projects/:projectId')?.params.projectId;
  const current = page ?? chatProjectId;
  const [seenKey, setSeenKey] = useState(refreshKey);
  if (seenKey !== refreshKey) {
    setSeenKey(refreshKey);
    reload();
  }

  const done = (project: ProjectDto | null) => {
    setAdding(false);
    if (!project) return;
    onChanged();
    onNavigate();
    void navigate(`/projects/${encodeURIComponent(project.id)}`);
  };

  return (
    <>
      <div className={shell.sectionHead}>
        <span className={shell.sectionLabel}>{ru.projects.title}</span>
        <IconButton icon="plus" size="sm" label={ru.projects.new} onClick={() => setAdding(true)} />
      </div>
      {adding ? <NewProject onDone={done} /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready'
        ? state.data.projects.map((p) => (
            <Link key={p.id} to={`/projects/${encodeURIComponent(p.id)}`} onClick={onNavigate} className={cx(shell.item, p.id === current && shell.itemCurrent)} aria-current={p.id === page ? 'page' : undefined}>
              <Icon name="folder" size={15} className={p.id === current ? styles.chipIconOn : styles.chipIcon} />
              <span className={shell.itemText}>{p.name}</span>
              <span className={styles.count}>{p.threadCount}</span>
            </Link>
          ))
        : null}
    </>
  );
}
