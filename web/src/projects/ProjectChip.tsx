// The chip of the conversation's project in the input (spec, scenario 6; mockup): the project, or
// without one only the folder, the size of the paperclip next to it (decision of the owner 15.11); its
// menu (ProjectPicker.tsx) moves the conversation into another project or out of it — also before the
// first message — and «Новый проект» creates one and moves the conversation there.
import type { ProjectDto } from '@bba/contracts';
import { useRef, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Menu, MenuAnchor } from '../ui/Menu.tsx';
import { fetchProjects, setThreadProject } from './api.ts';
import { NewProjectDialog } from './ProjectDialog.tsx';
import { ProjectPicker } from './ProjectPicker.tsx';
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
  // One button with or without a project: React keeps the element, so the focus stays on it.
  const chip = useRef<HTMLButtonElement>(null);

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
  // The keyboard that was in the menu (its search line, an item) comes back to the chip: with the menu
  // gone it would land at the start of the page. A click away moves it on to what was clicked.
  function closeMenu() {
    if (chip.current?.parentElement?.contains(document.activeElement)) chip.current.focus();
    setOpen(false);
  }
  async function move(target: ProjectRef | null) {
    closeMenu();
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
        <button ref={chip} type="button" className={cx(styles.chip, styles.chipOn)} onClick={toggle} aria-haspopup="menu" aria-expanded={open} title={ru.projects.ofThread}>
          <Icon name={project.shared ? 'folderShared' : 'folder'} size={15} className={styles.chipIconOn} />
          <span className={styles.chipName}>{project.name}</span>
          <Icon name="down" size={15} className={styles.chipIcon} />
        </button>
      ) : (
        <button
          ref={chip}
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
      <Menu open={open} onClose={closeMenu} label={ru.projects.ofThread} placement="top-start" width={270}>
        <ProjectPicker
          projects={projects}
          currentId={project?.id ?? null}
          onPick={(target) => void move(target)}
          onNew={() => {
            setOpen(false);
            setCreating(true);
          }}
        />
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
