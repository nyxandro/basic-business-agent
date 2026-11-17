// The order and the search of the project picker of the input (owner 17.11): the most recent work
// first, or by name. The chosen order is a convenience of this browser: without storage it is «недавние».
import { byProjectName, byRecentWork, type ProjectDto } from '@bba/contracts';

export type PickerSort = 'recent' | 'name';

export const PICKER_SORT_KEY = 'bba-project-picker-sort';

type Listed = Pick<ProjectDto, 'id' | 'name' | 'lastActiveAt' | 'unseen'>;

// «Недавние» — the same order as the unpinned projects of the side panel.
export function sortProjects<T extends Listed>(list: readonly T[], sort: PickerSort): T[] {
  return [...list].sort(sort === 'name' ? (a, b) => byProjectName.compare(a.name, b.name) : byRecentWork);
}

const fold = (text: string) => text.toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();

// Projects whose name holds the typed text anywhere, regardless of case and «ё».
export function matchProjects<T extends Pick<ProjectDto, 'name'>>(list: readonly T[], query: string): T[] {
  const needle = fold(query);
  return needle ? list.filter((p) => fold(p.name).includes(needle)) : [...list];
}

export function readPickerSort(): PickerSort {
  try {
    return localStorage.getItem(PICKER_SORT_KEY) === 'name' ? 'name' : 'recent';
  } catch {
    return 'recent';
  }
}

export function savePickerSort(sort: PickerSort): void {
  try {
    localStorage.setItem(PICKER_SORT_KEY, sort);
  } catch {
    // Without storage the order holds until the menu closes; nothing else to do.
  }
}
