// «Проекты» of the side panel (spec, scenario 6, sections 8.12 and 8.20): «+» opens the window «Новый
// проект» — the name and who it is open to (decision of the owner 16.11) — and the project's page
// opens after it. The panel shows the first seven, as «Недавние», and «Ещё» opens all of them in the window of «Поиск»
// on «Проекты» (request of the owner 17.11); the open project beyond the seven is shown as the eighth, or it could be
// neither pinned nor dragged up. Under the list, «Архив · N» when the person has archived projects. The pinned projects come first; the person drags a project
// up and down among its group, and the panel shows the new order at once, before the server keeps
// it. Saves go one after another, so the server ends with the last order the person made.
import type { ProjectDto } from '@bba/contracts';
import { closestCenter, DndContext, KeyboardCode, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors, type Announcements, type DragEndEvent, type UniqueIdentifier } from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useMatch, useNavigate } from 'react-router';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Icon } from '../ui/Icon.tsx';
import { useLoad } from '../ui/use-load.ts';
import shell from '../layout/shell.module.css';
import { useToast } from '../ui/Toast.tsx';
import { archiveProject, fetchProjects, orderProjects, unarchiveProject, updateProject } from './api.ts';
import { AccessDialog, NewProjectDialog } from './ProjectDialog.tsx';
import { moveProject, pinProject } from './order.ts';
import { ARCHIVE_PATH, projectPath, ProjectRow } from './ProjectRow.tsx';
import styles from './projects.module.css';

// How many projects the panel shows, as many as «Недавние» (request of the owner 17.11).
export const PROJECTS_SHOWN = 7;

// The first ones in the order of the panel, and the open one when it is further down.
function shownOf(projects: ProjectDto[], current: string | null | undefined): ProjectDto[] {
  const first = projects.slice(0, PROJECTS_SHOWN);
  const open = current && !first.some((p) => p.id === current) ? projects.find((p) => p.id === current) : undefined;
  return open ? [...first, open] : first;
}

// A mouse drag starts after this many pixels: a click stays a click.
const DRAG_START_PX = 6;
// On a touch screen a press held this long picks the project up; a finger that moves sooner scrolls.
const TOUCH_HOLD_MS = 250;
const TOUCH_TOLERANCE_PX = 6;
// The keyboard picks a project up only by the space bar: Enter keeps opening it.
const KEYBOARD_CODES = { start: [KeyboardCode.Space], cancel: [KeyboardCode.Esc], end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab] };
// A project moves only up and down, inside its group (pinned or not).
const MODIFIERS = [restrictToVerticalAxis, restrictToParentElement];

// A mouse drag (or a long press) ends with a click on the link under the pointer. dnd-kit keeps
// that click from React, but not from the browser, which would follow the link and load the whole
// page again: from the start of a drag until just after its end the window cancels it first.
function cancelClick(event: Event) {
  event.preventDefault();
}

export function ProjectList({ refreshKey, chatProjectId, onNavigate, onChanged, onShowAll }: { refreshKey: number; chatProjectId: string | null; onNavigate: () => void; onChanged: () => void; onShowAll: () => void }) {
  const saves = useRef<Promise<unknown>>(Promise.resolve());
  // The list loads after the saves under way, and once more when a save starts while it loads:
  // it never brings back an order being saved.
  const load = useCallback(async () => {
    for (;;) {
      const pending = saves.current;
      await pending;
      const data = await fetchProjects();
      if (saves.current === pending) return data;
    }
  }, []);
  const { state, reload } = useLoad(load);
  const [adding, setAdding] = useState(false);
  const [accessOf, setAccessOf] = useState<ProjectDto | null>(null);
  const [actionError, setActionError] = useState<ApiRequestError | null>(null);
  const toast = useToast();
  // The order, pins and names the person just changed, over the list they were made on: a list
  // loaded again (it has them from the server) takes their place.
  const [changed, setChanged] = useState<{ over: ProjectDto[]; list: ProjectDto[] } | null>(null);
  const [saveError, setSaveError] = useState<ApiRequestError | null>(null);
  // A project pinned or unpinned from its menu moves to the other group and is drawn anew: its link
  // takes the keyboard back.
  const focusNext = useRef<string | null>(null);
  const navigate = useNavigate();
  const archivePage = useMatch(ARCHIVE_PATH) !== null;
  const projectPage = useMatch('/projects/:projectId')?.params.projectId;
  const page = archivePage ? undefined : projectPage;
  const current = page ?? chatProjectId;
  const [seenKey, setSeenKey] = useState(refreshKey);
  if (seenKey !== refreshKey) {
    setSeenKey(refreshKey);
    reload();
  }
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: DRAG_START_PX } }),
    useSensor(TouchSensor, { activationConstraint: { delay: TOUCH_HOLD_MS, tolerance: TOUCH_TOLERANCE_PX } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: KEYBOARD_CODES }),
  );
  useEffect(() => () => window.removeEventListener('click', cancelClick, true), []);

  const loaded = state.status === 'ready' ? state.data.projects : null;
  const projects = changed && changed.over === loaded ? changed.list : loaded;

  const created = (project: ProjectDto) => {
    setAdding(false);
    onChanged();
    onNavigate();
    void navigate(projectPath(project.id));
  };

  // «В архив» from the menu: gone from everyone's «Проекты», «Вернуть» brings it back.
  async function archive(project: ProjectDto) {
    setActionError(null);
    try {
      await archiveProject(project.id);
    } catch (raw) {
      setActionError(asApiError(raw));
      return;
    }
    onChanged();
    if (page === project.id) void navigate('/', { replace: true });
    toast(ru.projects.archived(project.name), {
      label: ru.projects.undo,
      run: () => void unarchiveProject(project.id).then(onChanged, (raw: unknown) => setActionError(asApiError(raw))),
    });
  }

  function show(list: ProjectDto[] | null, save?: () => Promise<unknown>) {
    if (!list || !loaded) return;
    setSaveError(null);
    setChanged({ over: loaded, list });
    if (!save) return;
    const saved = saves.current.then(save);
    saves.current = saved.catch(() => undefined);
    // The list of the server comes after the rest of the saves: it has what did get saved.
    saved.catch((raw: unknown) => {
      setSaveError(asApiError(raw));
      reload();
    });
  }

  function afterDrag() {
    setTimeout(() => window.removeEventListener('click', cancelClick, true));
  }

  function drop({ active, over }: DragEndEvent) {
    afterDrag();
    if (!projects || !over) return;
    const list = moveProject(projects, String(active.id), String(over.id));
    if (list) show(list, () => orderProjects(list.map((p) => p.id)));
  }

  const nameOf = (id: UniqueIdentifier) => projects?.find((p) => p.id === id)?.name ?? '';
  const placeOf = (id: UniqueIdentifier) => (projects?.findIndex((p) => p.id === id) ?? 0) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => ru.projects.dragStart(nameOf(active.id)),
    onDragOver: ({ active, over }) => (over ? ru.projects.dragOver(nameOf(active.id), placeOf(over.id)) : undefined),
    onDragEnd: ({ active, over }) => (over ? ru.projects.dragEnd(nameOf(active.id), placeOf(over.id)) : ru.projects.dragCancel(nameOf(active.id))),
    onDragCancel: ({ active }) => ru.projects.dragCancel(nameOf(active.id)),
  };
  const shown = projects ? shownOf(projects, current) : [];
  // Dragging and pinning work on the whole list: a shown project moves to the place of another in it.
  const groups = [shown.filter((p) => p.pinned), shown.filter((p) => !p.pinned)];

  return (
    <>
      <div className={shell.sectionHead}>
        <span className={shell.sectionLabel}>{ru.projects.title}</span>
        <IconButton icon="plus" size="sm" label={ru.projects.new} onClick={() => setAdding(true)} />
      </div>
      <NewProjectDialog open={adding} onClose={() => setAdding(false)} onCreated={created} />
      <AccessDialog
        project={accessOf}
        onClose={() => setAccessOf(null)}
        onSaved={() => {
          setAccessOf(null);
          toast(ru.projects.accessSaved);
          onChanged();
        }}
      />
      {actionError ? <ErrorBanner error={actionError} /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {saveError ? <ErrorBanner title={ru.projects.orderFailed} error={saveError} /> : null}
      {projects ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={MODIFIERS}
          accessibility={{ announcements, screenReaderInstructions: { draggable: ru.projects.dragHint } }}
          onDragStart={() => window.addEventListener('click', cancelClick, true)}
          onDragEnd={drop}
          onDragCancel={afterDrag}
        >
          {groups.map((group, i) =>
            group.length > 0 ? (
              <div key={i === 0 ? 'pinned' : 'rest'} className={styles.projectGroup}>
                <SortableContext items={group.map((p) => p.id)} strategy={verticalListSortingStrategy}>
                  {group.map((p) => (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      current={p.id === current}
                      page={p.id === page}
                      onNavigate={onNavigate}
                      onRenamed={(name) => {
                        show(projects.map((x) => (x.id === p.id ? { ...x, name } : x)));
                        onChanged();
                      }}
                      onPin={(pinned) => {
                        focusNext.current = p.id;
                        show(pinProject(projects, p.id, pinned), () => updateProject(p.id, { pinned }));
                      }}
                      onAccess={() => setAccessOf(p)}
                      onArchive={() => void archive(p)}
                      takeFocus={() => {
                        if (focusNext.current !== p.id) return false;
                        focusNext.current = null;
                        return true;
                      }}
                    />
                  ))}
                </SortableContext>
              </div>
            ) : null,
          )}
        </DndContext>
      ) : null}
      {projects && projects.length > shown.length ? (
        <button type="button" className={shell.more} onClick={onShowAll}>
          {ru.projects.more}
        </button>
      ) : null}
      {state.status === 'ready' && state.data.archivedCount > 0 ? (
        <Link to={ARCHIVE_PATH} onClick={onNavigate} className={cx(shell.item, styles.archiveRow)} aria-current={archivePage ? 'page' : undefined}>
          <Icon name="archive" size={15} />
          <span className={shell.itemText}>
            {ru.projects.archiveLink} · {state.data.archivedCount}
          </span>
        </Link>
      ) : null}
    </>
  );
}
