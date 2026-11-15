// The chip of the conversation's project in the input (spec, scenario 6; mockup): the project, or
// without one only the folder, the size of the paperclip next to it (decision of the owner 15.11); its
// menu moves the conversation into another project or out of it — also before the first message — and
// «Новый проект» creates one and moves the conversation there.
import type { ProjectDto } from '@bba/contracts';
import { useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Menu, MenuAnchor, MenuItem, MenuSeparator, MenuTitle } from '../ui/Menu.tsx';
import { fetchProjects, setThreadProject } from './api.ts';
import { NewProjectDialog } from './ProjectDialog.tsx';
import type { ProjectRef, ThreadProjectState } from './use-thread-project.ts';
import styles from './projects.module.css';

interface ChipProps {
  threadId: string;
  state: ThreadProjectState;
  retry: () => void;
  changed: (project: ProjectRef | null) => void;
  // «Новый разговор в проекте» could not put the conversation into the project.
  moveError: ApiRequestError | null;
}

export function ProjectChip({ threadId, state, retry, changed, moveError }: ChipProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);

  if (state.status === 'loading') return null;
  if (state.status === 'error') {
    return (
      <button type="button" className={cx(styles.chip, styles.chipBad)} onClick={retry} title={state.error.message}>
        <Icon name="alert" size={15} />
        <span className={styles.chipName}>{ru.projects.chipFailed}</span>
      </button>
    );
  }
  const project = state.data;

  function toggle() {
    const next = !open;
    setOpen(next);
    setError(null);
    if (next) fetchProjects().then((r) => setProjects(r.projects), (raw: unknown) => (setOpen(false), setError(asApiError(raw))));
  }
  async function move(target: ProjectRef | null) {
    setOpen(false);
    setError(null);
    try {
      await setThreadProject(threadId, target?.id ?? null);
      changed(target);
    } catch (raw) {
      setError(asApiError(raw));
    }
  }

  return (
    <MenuAnchor>
      {project ? (
        <button type="button" className={cx(styles.chip, styles.chipOn)} onClick={toggle} aria-haspopup="menu" aria-expanded={open} title={ru.projects.ofThread}>
          <Icon name={project.shared ? 'folderShared' : 'folder'} size={15} className={styles.chipIconOn} />
          <span className={styles.chipName}>{project.name}</span>
          <Icon name="down" size={15} className={styles.chipIcon} />
        </button>
      ) : (
        <button
          type="button"
          className={cx(styles.chip, styles.chipBare)}
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${ru.projects.ofThread}: ${ru.projects.none}`}
          title={`${ru.projects.ofThread}: ${ru.projects.none}`}
        >
          <Icon name="folder" size={17} className={styles.chipIcon} />
        </button>
      )}
      <Menu open={open} onClose={() => setOpen(false)} label={ru.projects.ofThread} placement="top-start" width={270}>
        <MenuTitle>{ru.projects.ofThread}</MenuTitle>
        <MenuItem icon="chat" checked={!project} onSelect={() => void move(null)}>
          {ru.projects.none}
        </MenuItem>
        {(projects ?? []).map((p) => (
          <MenuItem key={p.id} icon={p.shared ? 'folderShared' : 'folder'} checked={p.id === project?.id} onSelect={() => void move({ id: p.id, name: p.name, shared: p.shared })}>
            {p.name}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          icon="plus"
          accent
          onSelect={() => {
            setOpen(false);
            setCreating(true);
          }}
        >
          {ru.projects.new}
        </MenuItem>
      </Menu>
      <NewProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(p) => {
          setCreating(false);
          void move({ id: p.id, name: p.name, shared: p.shared });
        }}
      />
      {(error ?? moveError) ? (
        <span className={styles.chipError} role="alert">
          {(error ?? moveError)!.message}
        </span>
      ) : null}
    </MenuAnchor>
  );
}
