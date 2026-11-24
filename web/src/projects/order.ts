// The order of «Проекты» in the side panel (spec, section 8.12; decision of the owner 17.11): the pinned
// projects first, in the order the person dragged them; then the rest by the person's latest work
// (`byRecentWork`). The server keeps the same rules; these give the panel the new order at once,
// before the server answers. The list comes in the panel's order.
import { byRecentWork, type ProjectDto } from '@bba/contracts';
import { arrayMove } from '@dnd-kit/sortable';

// How many projects the panel shows, as many as «Недавние» (request of the owner 17.11); the pinned
// ones are all shown, however many.
export const PROJECTS_SHOWN = 10;

function indexOf(list: readonly ProjectDto[], id: string): number {
  const index = list.findIndex((p) => p.id === id);
  if (index < 0) throw new Error(`project ${id} is not in the panel's list`);
  return index;
}

// A pinned project dragged onto the place of another pinned one; null when nothing moves (its own
// place, or an unpinned project — those go by work).
export function moveProject(list: readonly ProjectDto[], id: string, overId: string): ProjectDto[] | null {
  const from = indexOf(list, id);
  const to = indexOf(list, overId);
  if (from === to || !list[from]!.pinned || !list[to]!.pinned) return null;
  return arrayMove([...list], from, to);
}

// A pinned project goes after the pinned ones, an unpinned one — among the rest by its latest work.
// Null when the project already is so.
export function pinProject(list: readonly ProjectDto[], id: string, pinned: boolean): ProjectDto[] | null {
  const project = list[indexOf(list, id)]!;
  if (project.pinned === pinned) return null;
  const others = list.filter((p) => p.id !== id);
  const pinnedOnes = others.filter((p) => p.pinned);
  const rest = others.filter((p) => !p.pinned);
  return pinned ? [...pinnedOnes, { ...project, pinned }, ...rest] : [...pinnedOnes, ...[...rest, { ...project, pinned }].sort(byRecentWork)];
}

// What the panel shows: every pinned project, the rest up to seven in all, and the open project when
// it is further down — otherwise it could not be pinned from its row.
export function shownProjects(list: readonly ProjectDto[], current: string | null | undefined): ProjectDto[] {
  const first = list.slice(0, Math.max(PROJECTS_SHOWN, list.filter((p) => p.pinned).length));
  const open = current && !first.some((p) => p.id === current) ? list.find((p) => p.id === current) : undefined;
  return open ? [...first, open] : first;
}
