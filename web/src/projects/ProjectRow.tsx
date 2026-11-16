// A project of «Проекты» in the side panel (spec, sections 8.12 and 8.20): its link — a shared project
// with the folder with a person, «новое» until a colleague opens it — a pin when it is pinned, and
// three dots on hover — on a phone always: its creator gets «Переименовать», «Закрепить» / «Открепить»,
// «Настроить доступ» and «В архив»; a colleague only pins. The row is dragged up and down among its
// group: by the mouse, by a long press on a touch screen, by the space bar and the arrows.
import type { ProjectDto } from '@bba/contracts';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { ru } from '../i18n/ru.ts';
import { RenameField } from '../layout/RenameField.tsx';
import shell from '../layout/shell.module.css';
import { cx, IconButton } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Menu, MenuAnchor, MenuItem } from '../ui/Menu.tsx';
import { accessText } from './AccessPicker.tsx';
import { updateProject } from './api.ts';
import styles from './projects.module.css';
import { usePrefetchProject } from './queries.ts';

export const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;
export const ARCHIVE_PATH = '/projects/archive';

// Who the project is open to, or who opened it, for the hint of its icon.
export function sharedHint(project: ProjectDto): string {
  if (project.role === 'member') return ru.projects.openedBy(project.owner.name);
  return project.access ? accessText(project.access) : ru.projects.shared;
}

// `takeFocus` says once that the link takes the keyboard on being drawn (after «Закрепить»).
export function ProjectRow({ project, current, page, onNavigate, onRenamed, onPin, onAccess, onArchive, takeFocus }: { project: ProjectDto; current: boolean; page: boolean; onNavigate: () => void; onRenamed: (name: string) => void; onPin: (pinned: boolean) => void; onAccess: () => void; onArchive: () => void; takeFocus: () => boolean }) {
  const [menu, setMenu] = useState(false);
  const prefetch = usePrefetchProject();
  const [editing, setEditing] = useState(false);
  // The link comes back after the field: it takes the keyboard when the field had it.
  const refocus = useRef(false);
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({ id: project.id, disabled: editing });
  const label = ru.projects.menuOf(project.name);
  const owner = project.role === 'owner';

  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cx(styles.projectRow, isDragging && styles.projectDragging)}>
      {editing ? (
        <RenameField
          value={project.name}
          label={ru.projects.name}
          saveLabel={ru.projects.save}
          save={async (name) => (await updateProject(project.id, { name })).name}
          onDone={(name, fromField) => {
            refocus.current = fromField;
            setEditing(false);
            if (name) onRenamed(name);
          }}
        />
      ) : (
        <div className={cx(shell.threadRow, current && shell.itemCurrent, menu && shell.threadRowOpen)}>
          <Link
            ref={(link) => {
              setActivatorNodeRef(link);
              if (!link || !(refocus.current || takeFocus())) return;
              refocus.current = false;
              link.focus();
            }}
            to={projectPath(project.id)}
            onClick={onNavigate}
            // Its data starts to load while the pointer or the keyboard is on it (spec, section 8.22).
            onMouseEnter={() => prefetch(project.id)}
            onFocus={() => prefetch(project.id)}
            className={cx(shell.item, shell.threadLink, styles.projectLink)}
            aria-current={page ? 'page' : undefined}
            aria-describedby={attributes['aria-describedby']}
            // The row is dragged by our code, not as a link the browser carries elsewhere.
            draggable={false}
            {...listeners}
          >
            <Icon name={project.shared ? 'folderShared' : 'folder'} size={15} className={current ? styles.chipIconOn : styles.chipIcon} {...(project.shared ? { label: sharedHint(project) } : {})} />
            <span className={shell.itemText} title={project.shared ? sharedHint(project) : undefined}>
              {project.name}
            </span>
            {project.unseen ? <span className={styles.newPill}>{ru.chat.unread}</span> : null}
            {project.pinned ? <Icon name="pin" size={13} label={ru.projects.pinned} className={styles.pinMark} /> : null}
          </Link>
          <div className={shell.threadMore}>
            <MenuAnchor>
              <IconButton icon="dots" size="sm" label={label} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} />
              <Menu open={menu} onClose={() => setMenu(false)} label={label}>
                {owner ? (
                  <MenuItem
                    icon="edit"
                    onSelect={() => {
                      setMenu(false);
                      setEditing(true);
                    }}
                  >
                    {ru.projects.rename}
                  </MenuItem>
                ) : null}
                <MenuItem
                  icon={project.pinned ? 'unpin' : 'pin'}
                  onSelect={() => {
                    setMenu(false);
                    onPin(!project.pinned);
                  }}
                >
                  {project.pinned ? ru.projects.unpin : ru.projects.pin}
                </MenuItem>
                {owner ? (
                  <>
                    <MenuItem
                      icon="users"
                      onSelect={() => {
                        setMenu(false);
                        onAccess();
                      }}
                    >
                      {ru.projects.accessEdit}
                    </MenuItem>
                    <MenuItem
                      icon="archive"
                      onSelect={() => {
                        setMenu(false);
                        onArchive();
                      }}
                    >
                      {ru.projects.archive}
                    </MenuItem>
                  </>
                ) : null}
              </Menu>
            </MenuAnchor>
          </div>
        </div>
      )}
    </div>
  );
}
