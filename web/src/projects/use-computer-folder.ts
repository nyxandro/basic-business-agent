// The folder of the person's computer given to a project, as this browser holds it for the person signed in (spec, section
// 8.25; another person signed in to the same browser never gets it): the folder and its mode, whether the browser lets it be used now, and the actions — choose, allow, change the mode,
// forget. Every place that shows the folder (the chip of the input, the project's page) learns of a change at once.
import { useCallback, useEffect, useState } from 'react';
import { accessOf, adoptFiles, allowAccess, canKeepFolder, changeMode, folderKey, folderOf, forgetFolder, onFolderChange, pickFolder, type ComputerFolder, type FolderAccess, type FolderMode } from './computer-folder.ts';
import { canWriteFolder } from './computer-write.ts';

export interface ComputerFolderState {
  folder: ComputerFolder | null;
  access: FolderAccess | null;
  // The folder's mode: a folder of a file input is read only.
  mode: FolderMode | null;
  // The browser keeps the folder itself (Chrome and its kin); otherwise it lives while the tab is open.
  keeps: boolean;
  // The browser can write into a folder (Chrome, Edge, Yandex Browser).
  writes: boolean;
  choose: (mode: FolderMode) => Promise<void>;
  allow: () => Promise<void>;
  // The browser's answer: a refusal keeps the mode as it was.
  setMode: (mode: FolderMode) => Promise<FolderAccess>;
  forget: () => Promise<void>;
}

// A browser without the folder picker (Firefox, Safari): an input of files with the whole folder, put on the
// page for the moment of the choice. `webkitdirectory` is understood by every current browser.
function chooseWithInput(key: string): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  input.setAttribute('webkitdirectory', '');
  input.addEventListener('change', () => {
    if (input.files && input.files.length > 0) adoptFiles(key, input.files);
    input.remove();
  });
  input.addEventListener('cancel', () => input.remove());
  document.body.append(input);
  input.click();
}

export function useComputerFolder(projectId: string | null, userId: string): ComputerFolderState {
  const key = projectId ? folderKey(userId, projectId) : null;
  const [folder, setFolder] = useState<ComputerFolder | null>(null);
  const [access, setAccess] = useState<FolderAccess | null>(null);
  const [turn, setTurn] = useState(0);

  useEffect(() => {
    if (!key) return;
    return onFolderChange((changed) => {
      if (changed === key) setTurn((n) => n + 1);
    });
  }, [key]);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const found = key ? await folderOf(key) : null;
      const now = found ? await accessOf(found).catch((): FolderAccess => 'denied') : null;
      if (!live) return;
      setFolder(found);
      setAccess(now);
    };
    void load();
    return () => {
      live = false;
    };
  }, [key, turn]);

  const choose = useCallback(
    async (mode: FolderMode) => {
      if (!key) return;
      if (canKeepFolder()) await pickFolder(key, mode);
      else chooseWithInput(key);
    },
    [key],
  );
  const allow = useCallback(async () => {
    if (key && folder) await allowAccess(key, folder);
  }, [key, folder]);
  const setMode = useCallback(
    async (mode: FolderMode): Promise<FolderAccess> => {
      if (!key || !folder) throw new Error('no folder to change the mode of');
      return changeMode(key, folder, mode);
    },
    [key, folder],
  );
  const forget = useCallback(async () => {
    if (key) await forgetFolder(key);
  }, [key]);
  const mode = folder ? (folder.kind === 'handle' ? folder.mode : 'read') : null;
  return { folder, access, mode, keeps: canKeepFolder(), writes: canWriteFolder(), choose, allow, setMode, forget };
}
