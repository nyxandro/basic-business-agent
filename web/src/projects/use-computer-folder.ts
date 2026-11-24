// The folder of the person's computer given to a project, as this browser holds it (spec, section 8.25): the
// folder and its mode, whether the browser lets it be used now, and the actions — choose, allow, change the mode,
// forget. Every place that shows the folder (the chip of the input, the project's page) learns of a change at once.
import { useCallback, useEffect, useState } from 'react';
import { accessOf, adoptFiles, allowAccess, canKeepFolder, changeMode, folderOf, forgetFolder, onFolderChange, pickFolder, type ComputerFolder, type FolderAccess, type FolderMode } from './computer-folder.ts';
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
function chooseWithInput(projectId: string): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  input.setAttribute('webkitdirectory', '');
  input.addEventListener('change', () => {
    if (input.files && input.files.length > 0) adoptFiles(projectId, input.files);
    input.remove();
  });
  input.addEventListener('cancel', () => input.remove());
  document.body.append(input);
  input.click();
}

export function useComputerFolder(projectId: string | null): ComputerFolderState {
  const [folder, setFolder] = useState<ComputerFolder | null>(null);
  const [access, setAccess] = useState<FolderAccess | null>(null);
  const [turn, setTurn] = useState(0);

  useEffect(() => {
    if (!projectId) return;
    return onFolderChange((changed) => {
      if (changed === projectId) setTurn((n) => n + 1);
    });
  }, [projectId]);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const found = projectId ? await folderOf(projectId) : null;
      const now = found ? await accessOf(found).catch((): FolderAccess => 'denied') : null;
      if (!live) return;
      setFolder(found);
      setAccess(now);
    };
    void load();
    return () => {
      live = false;
    };
  }, [projectId, turn]);

  const choose = useCallback(
    async (mode: FolderMode) => {
      if (!projectId) return;
      if (canKeepFolder()) await pickFolder(projectId, mode);
      else chooseWithInput(projectId);
    },
    [projectId],
  );
  const allow = useCallback(async () => {
    if (projectId && folder) await allowAccess(projectId, folder);
  }, [projectId, folder]);
  const setMode = useCallback(
    async (mode: FolderMode): Promise<FolderAccess> => {
      if (!projectId || !folder) throw new Error('no folder to change the mode of');
      return changeMode(projectId, folder, mode);
    },
    [projectId, folder],
  );
  const forget = useCallback(async () => {
    if (projectId) await forgetFolder(projectId);
  }, [projectId]);
  const mode = folder ? (folder.kind === 'handle' ? folder.mode : 'read') : null;
  return { folder, access, mode, keeps: canKeepFolder(), writes: canWriteFolder(), choose, allow, setMode, forget };
}
