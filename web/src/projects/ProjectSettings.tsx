// «Настройки проекта» behind the gear at the end of the tabs of a project page (request of the owner 17.11):
// the instructions for the agent, the memory of the project and the folder of the person's computer. The creator
// edits the instructions; a colleague reads them. An archived project is only read: no folder, memory read only.
import type { ProjectDto } from '@bba/contracts';
import { useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { MemoryEntries } from '../memory/MemoryEntries.tsx';
import { Button } from '../ui/Button.tsx';
import { Card } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { TextArea } from '../ui/Field.tsx';
import { useToast } from '../ui/Toast.tsx';
import { updateProject } from './api.ts';
import { ComputerFolderCard } from './ComputerFolderCard.tsx';
import styles from './projects.module.css';

function InstructionsText({ project }: { project: ProjectDto }) {
  return (
    <Card className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{ru.projects.instructions}</h2>
      </div>
      {project.role === 'member' ? <p className={styles.empty}>{ru.projects.instructionsByOwner}</p> : null}
      {project.instructions.trim() ? <p className={styles.instructionsText}>{project.instructions}</p> : <p className={styles.empty}>{ru.projects.noInstructions}</p>}
    </Card>
  );
}

function Instructions({ project, onSaved }: { project: ProjectDto; onSaved: (p: ProjectDto) => void }) {
  const [text, setText] = useState(project.instructions);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await updateProject(project.id, { instructions: text }));
      toast(ru.projects.saved);
    } catch (raw) {
      setError(asApiError(raw));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{ru.projects.instructions}</h2>
      </div>
      <p className={styles.empty}>{ru.projects.instructionsHint}</p>
      <TextArea aria-label={ru.projects.instructions} rows={6} value={text} onChange={(e) => setText(e.target.value)} />
      {error ? <ErrorBanner error={error} /> : null}
      <div className={styles.actions}>
        <Button variant="primary" disabled={busy || text === project.instructions} onClick={() => void save()}>
          {ru.projects.save}
        </Button>
      </div>
    </Card>
  );
}

export function ProjectSettings({ project, onSaved }: { project: ProjectDto; onSaved: (p: ProjectDto) => void }) {
  const archived = project.archivedAt !== null;
  return (
    <>
      {/* The page may show the project from memory first: the server's instructions, when different,
          start the field anew (spec, section 8.22). */}
      {project.role === 'owner' && !archived ? <Instructions key={`${project.id}:${project.instructions}`} project={project} onSaved={onSaved} /> : <InstructionsText project={project} />}
      {/* What the agents remember about the project (spec, section 8.26). */}
      <Card className={styles.section}>
        <MemoryEntries projectId={project.id} title={ru.memory.projectTitle} hint={ru.memory.projectHint} empty={ru.memory.projectEmpty} failed={ru.memory.projectFailed} readOnlyNote={ru.memory.projectArchived} />
      </Card>
      {/* A folder of this browser's computer for the agent (spec, section 8.25); not for an archived project. */}
      {archived ? null : <ComputerFolderCard projectId={project.id} />}
    </>
  );
}
