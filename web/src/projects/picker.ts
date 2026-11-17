// The order and the search of the project picker of the input (owner 17.11): the most recent work
// first, or by name. The chosen order is a convenience of this browser: without storage it is «недавние».
import type { ProjectDto } from '@bba/contracts';

export type PickerSort = 'recent' | 'name';

export const PICKER_SORT_KEY = 'bba-project-picker-sort';

// «Проект 9» before «Проект 10»; letter case and «ё» do not change the place.
const byName = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

type Listed = Pick<ProjectDto, 'name' | 'lastActiveAt' | 'unseen'>;

export function sortProjects<T extends Listed>(list: readonly T[], sort: PickerSort): T[] {
  const named = (a: T, b: T) => byName.compare(a.name, b.name);
  // A project a colleague has just opened to the person («новое» in the side panel) is the newest of
  // all, whenever it was created. lastActiveAt is an ISO time of the server: its text sorts as the time.
  const recent = (a: T, b: T) => Number(b.unseen) - Number(a.unseen) || b.lastActiveAt.localeCompare(a.lastActiveAt) || named(a, b);
  return [...list].sort(sort === 'name' ? named : recent);
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
