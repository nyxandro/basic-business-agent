// The window of a new project — its name and «Кому открыт» (decision of the owner 16.11: the access is
// chosen when the project is made) — and the window «Настроить доступ» of a project, with the access
// only (spec, section 8.20).
import type { ProjectDto } from '@bba/contracts';
import { useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { Modal } from '../ui/Modal.tsx';
import { AccessPicker, draftOf, draftReady, inputOf, PRIVATE_DRAFT, sameDraft, type AccessDraft } from './AccessPicker.tsx';
import { createProject, setProjectAccess } from './api.ts';
import styles from './projects.module.css';

const PROJECT_EXISTS = 'APP_PROJECT_EXISTS';

function NewProjectForm({ onClose, onCreated }: { onClose: () => void; onCreated: (p: ProjectDto) => void }) {
  const [name, setName] = useState('');
  const [access, setAccess] = useState<AccessDraft>(PRIVATE_DRAFT);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      onCreated(await createProject(name.trim(), inputOf(access)));
    } catch (raw) {
      setError(asApiError(raw));
      setBusy(false);
    }
  }
  return (
    <form
      className={styles.section}
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && draftReady(access) && !busy) void create();
      }}
    >
      <h2 className={styles.sectionTitle}>{ru.projects.new}</h2>
      <Field label={ru.projects.name} error={error?.code === PROJECT_EXISTS ? error.message : null}>
        {/* The window opens on the person's «+»: the name is what they came to type. */}
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={ru.projects.namePlaceholder} />
      </Field>
      <AccessPicker value={access} onChange={setAccess} closing={false} />
      {error && error.code !== PROJECT_EXISTS ? <ErrorBanner error={error} /> : null}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onClose}>
          {ru.projects.cancel}
        </Button>
        <Button type="submit" variant="primary" disabled={!name.trim() || !draftReady(access) || busy}>
          {ru.projects.create}
        </Button>
      </div>
    </form>
  );
}

export function NewProjectDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (p: ProjectDto) => void }) {
  return (
    <Modal open={open} onClose={onClose} label={ru.projects.new}>
      {/* Drawn anew on each opening: a closed window starts empty next time. */}
      {open ? <NewProjectForm onClose={onClose} onCreated={onCreated} /> : null}
    </Modal>
  );
}

function AccessForm({ project, onClose, onSaved }: { project: ProjectDto & { access: NonNullable<ProjectDto['access']> }; onClose: () => void; onSaved: (p: ProjectDto) => void }) {
  const [initial] = useState(() => draftOf(project.access));
  const [access, setAccess] = useState<AccessDraft>(initial);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await setProjectAccess(project.id, inputOf(access)));
    } catch (raw) {
      setError(asApiError(raw));
      setBusy(false);
    }
  }
  return (
    <form
      className={styles.section}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className={styles.sectionTitle}>{ru.projects.accessTitle}</h2>
      <p className={styles.lead}>{project.name}</p>
      <AccessPicker value={access} onChange={setAccess} closing={initial.mode !== 'private'} />
      {error ? <ErrorBanner error={error} /> : null}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onClose}>
          {ru.projects.cancel}
        </Button>
        <Button type="submit" variant="primary" disabled={!draftReady(access) || sameDraft(access, initial) || busy}>
          {ru.projects.save}
        </Button>
      </div>
    </form>
  );
}

export function AccessDialog({ project, onClose, onSaved }: { project: ProjectDto | null; onClose: () => void; onSaved: (p: ProjectDto) => void }) {
  const access = project?.access;
  return (
    <Modal open={project !== null && access !== null} onClose={onClose} label={ru.projects.accessTitle}>
      {project && access ? <AccessForm key={project.id} project={{ ...project, access }} onClose={onClose} onSaved={onSaved} /> : null}
    </Modal>
  );
}
