// The menu of the input's project chip (owner 17.11): «Без проекта», the projects and «Новый проект».
// More than five projects scroll inside the menu and get a small button that switches their order —
// the most recent work first, or by name (five and fewer — always the most recent: there is no button to
// switch back); more than twenty get a search line at the top in place of the title, and Enter in it
// picks the first project left.
import type { ProjectDto } from '@bba/contracts';
import { useState, type KeyboardEvent } from 'react';
import { ru } from '../i18n/ru.ts';
import { useMedia } from '../ui/use-media.ts';
import { IconButton } from '../ui/Button.tsx';
import { SearchInput } from '../ui/Field.tsx';
import { MenuItem, MenuSeparator, MenuTitle } from '../ui/Menu.tsx';
import { matchProjects, readPickerSort, savePickerSort, sortProjects, type PickerSort } from './picker.ts';
import type { ProjectRef } from './use-thread-project.ts';
import styles from './projects.module.css';

const ORDER_AFTER = 5;
const SEARCH_AFTER = 20;
// A mouse: no keyboard on the screen. A touch screen of any width would cover the list it searches.
const MOUSE_QUERY = '(pointer: fine)';

interface PickerProps {
  // Null while the list loads.
  projects: ProjectDto[] | null;
  currentId: string | null;
  onPick: (project: ProjectRef | null) => void;
  onNew: () => void;
}

export function ProjectPicker({ projects, currentId, onPick, onNew }: PickerProps) {
  const [sort, setSort] = useState<PickerSort>(readPickerSort);
  const [query, setQuery] = useState('');
  const mouse = useMedia(MOUSE_QUERY);
  const all = projects ?? [];
  const ordered = all.length > ORDER_AFTER;
  const searchable = all.length > SEARCH_AFTER;
  const shown = sortProjects(searchable ? matchProjects(all, query) : all, ordered ? sort : 'recent');
  const pick = (p: ProjectDto) => onPick({ id: p.id, name: p.name, shared: p.shared });

  function switchSort() {
    const next = sort === 'recent' ? 'name' : 'recent';
    setSort(next);
    savePickerSort(next);
  }
  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    const first = shown[0];
    // Without a word typed Enter picks nothing: the menu just opened, and a held key must not move the conversation.
    if (event.key !== 'Enter' || query.trim() === '' || !first) return;
    event.preventDefault();
    pick(first);
  }

  return (
    <>
      <div className={styles.pickerHead}>
        {searchable ? (
          <SearchInput label={ru.projects.find} placeholder={ru.projects.find} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey} autoFocus={mouse} className={styles.pickerSearch} />
        ) : (
          <MenuTitle>{ru.projects.ofThread}</MenuTitle>
        )}
        {ordered ? <IconButton size="sm" icon={sort === 'recent' ? 'clock' : 'sortName'} iconSize={16} label={ru.projects.order[sort]} onClick={switchSort} /> : null}
      </div>
      <MenuItem icon="chat" checked={currentId === null} onSelect={() => onPick(null)}>
        {ru.projects.none}
      </MenuItem>
      <div className={styles.pickerList}>
        {shown.map((p) => (
          <MenuItem key={p.id} icon={p.shared ? 'folderShared' : 'folder'} checked={p.id === currentId} onSelect={() => pick(p)}>
            {p.name}
          </MenuItem>
        ))}
        {searchable && shown.length === 0 ? <p className={styles.pickerEmpty}>{ru.projects.noMatches}</p> : null}
      </div>
      <MenuSeparator />
      <MenuItem icon="plus" accent onSelect={onNew}>
        {ru.projects.new}
      </MenuItem>
    </>
  );
}
