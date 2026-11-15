// The order of «Проекты» in the side panel (spec, section 8.12; decisions of the owner 15.11): the
// pinned projects first, then the rest. The server keeps the same rules; these give the panel the
// new order at once, before the server answers. The list comes in the panel's order.
import type { ProjectDto } from '@bba/contracts';
import { arrayMove } from '@dnd-kit/sortable';

function indexOf(list: readonly ProjectDto[], id: string): number {
  const index = list.findIndex((p) => p.id === id);
  if (index < 0) throw new Error(`project ${id} is not in the panel's list`);
  return index;
}

// A project dragged onto the place of another one of its own group; null when nothing moves (its
// own place, or a place in the other group — pinning is done from the menu).
export function moveProject(list: readonly ProjectDto[], id: string, overId: string): ProjectDto[] | null {
  const from = indexOf(list, id);
  const to = indexOf(list, overId);
  if (from === to || list[from]!.pinned !== list[to]!.pinned) return null;
  return arrayMove([...list], from, to);
}

// A pinned project goes after the pinned ones, an unpinned one — first among the rest: both land
// right at the border of the two groups. Null when the project already is so.
export function pinProject(list: readonly ProjectDto[], id: string, pinned: boolean): ProjectDto[] | null {
  const project = list[indexOf(list, id)]!;
  if (project.pinned === pinned) return null;
  const rest = list.filter((p) => p.id !== id);
  const border = rest.filter((p) => p.pinned).length;
  return [...rest.slice(0, border), { ...project, pinned }, ...rest.slice(border)];
}
