// A project of «Проекты» in the side panel (spec, section 8.12): its link, a pin when it is pinned,
// and three dots on hover — on a phone always — with «Переименовать» and «Закрепить» / «Открепить»
// (decisions of the owner 15.11: no number of conversations). The row is dragged up and down among
// its group: by the mouse, by a long press on a touch screen, by the space bar and the arrows.
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
import { updateProject } from './api.ts';
import styles from './projects.module.css';

export const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}`;

// `takeFocus` says once that the link takes the keyboard on being drawn (after «Закрепить»).
export function ProjectRow({ project, current, page, onNavigate, onRenamed, onPin, takeFocus }: { project: ProjectDto; current: boolean; page: boolean; onNavigate: () => void; onRenamed: (name: string) => void; onPin: (pinned: boolean) => void; takeFocus: () => boolean }) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  // The link comes back after the field: it takes the keyboard when the field had it.
  const refocus = useRef(false);
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({ id: project.id, disabled: editing });
  const label = ru.projects.menuOf(project.name);

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
            className={cx(shell.item, shell.threadLink, styles.projectLink)}
            aria-current={page ? 'page' : undefined}
            aria-describedby={attributes['aria-describedby']}
            // The row is dragged by our code, not as a link the browser carries elsewhere.
            draggable={false}
            {...listeners}
          >
            <Icon name="folder" size={15} className={current ? styles.chipIconOn : styles.chipIcon} />
            <span className={shell.itemText}>{project.name}</span>
            {project.pinned ? <Icon name="pin" size={13} label={ru.projects.pinned} className={styles.pinMark} /> : null}
          </Link>
          <div className={shell.threadMore}>
            <MenuAnchor>
              <IconButton icon="dots" size="sm" label={label} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} />
              <Menu open={menu} onClose={() => setMenu(false)} label={label}>
                <MenuItem
                  icon="edit"
                  onSelect={() => {
                    setMenu(false);
                    setEditing(true);
                  }}
                >
                  {ru.projects.rename}
                </MenuItem>
                <MenuItem
                  icon={project.pinned ? 'unpin' : 'pin'}
                  onSelect={() => {
                    setMenu(false);
                    onPin(!project.pinned);
                  }}
                >
                  {project.pinned ? ru.projects.unpin : ru.projects.pin}
                </MenuItem>
              </Menu>
            </MenuAnchor>
          </div>
        </div>
      )}
    </div>
  );
}
