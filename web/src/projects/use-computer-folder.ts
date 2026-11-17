// The folder of the person's computer given to a project, as this browser holds it (spec, section 8.25): the
// folder, whether the browser lets it be read now, and the actions — choose, allow, forget. Every place that
// shows the folder (the chip of the input, the project's page) learns of a change at once.
import { useCallback, useEffect, useState } from 'react';
import { accessOf, adoptFiles, allowAccess, canKeepFolder, folderOf, forgetFolder, onFolderChange, pickFolder, type ComputerFolder, type FolderAccess } from './computer-folder.ts';

export interface ComputerFolderState {
  folder: ComputerFolder | null;
  access: FolderAccess | null;
  // The browser keeps the folder itself (Chrome and its kin); otherwise it lives while the tab is open.
  keeps: boolean;
  choose: () => Promise<void>;
  allow: () => Promise<void>;
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

  const choose = useCallback(async () => {
    if (!projectId) return;
    if (canKeepFolder()) await pickFolder(projectId);
    else chooseWithInput(projectId);
  }, [projectId]);
  const allow = useCallback(async () => {
    if (projectId && folder) await allowAccess(projectId, folder);
  }, [projectId, folder]);
  const forget = useCallback(async () => {
    if (projectId) await forgetFolder(projectId);
  }, [projectId]);
  return { folder, access, keeps: canKeepFolder(), choose, allow, forget };
}
