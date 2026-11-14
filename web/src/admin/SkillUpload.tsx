// «Добавить скилл» (spec, scenario 10): a `.skill` file is checked before saving — its name, what it
// does, the files and whether it has scripts; then who gets it. A skill with the same name is
// replaced with the new version («Заменить»), its access stays. A refused archive says why.
import type { AdminDepartment, AdminUser, SkillAccess, SkillPreview } from '@bba/contracts';
import { useRef, useState } from 'react';
import { Button } from '../ui/Button.tsx';
import { fileSize, plural } from '../ui/format.ts';
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';
import { AccessPicker, accessIsEmpty } from './AccessPicker.tsx';
import { adminApi } from './api.ts';
import { Feedback, useAction } from './parts.tsx';
import section from './section.module.css';
import styles from './skills.module.css';

const SHOWN_FILES = 8;

function Preview({ preview }: { preview: SkillPreview }) {
  return (
    <div className={styles.preview}>
      <div className={styles.previewHead}>
        <span className={styles.previewTitle}>{preview.title}</span>
        <span className={styles.mono}>{preview.name}</span>
      </div>
      <p className={section.note}>{preview.description}</p>
      <div className={section.sub}>
        {preview.files.length} {plural(preview.files.length, ['файл', 'файла', 'файлов'])} · {fileSize(preview.sizeBytes)}
      </div>
      <ul className={styles.files}>
        {preview.files.slice(0, SHOWN_FILES).map((f) => (
          <li key={f.path} className={styles.mono}>
            {f.path}
          </li>
        ))}
        {preview.files.length > SHOWN_FILES ? <li className={section.sub}>и ещё {preview.files.length - SHOWN_FILES}</li> : null}
      </ul>
      {preview.hasScripts ? (
        <p className={styles.scripts}>
          <Icon name="term" size={15} />
          Есть скрипты — они выполняются в песочнице: своя папка у каждого сотрудника, без сети.
        </p>
      ) : null}
      {preview.exists ? <p className={styles.replace}>Скилл с таким именем уже загружен — сохранение заменит его новой версией, доступ останется прежним.</p> : null}
    </div>
  );
}

function UploadBody({ departments, users, onClose, onSaved }: { departments: AdminDepartment[]; users: AdminUser[]; onClose: () => void; onSaved: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [access, setAccess] = useState<SkillAccess>({ scope: 'org', departmentIds: [], userIds: [] });
  const { busy, error, run, clearError } = useAction();

  async function choose(next: File) {
    setFile(next);
    setPreview(null);
    clearError();
    await run(async () => setPreview(await adminApi.checkSkill(next)), null);
  }
  async function save() {
    if (!file || !preview) return;
    const ok = preview.exists ? await run(() => adminApi.replaceSkill(preview.name, file), 'Скилл заменён') : await run(() => adminApi.createSkill(file, access), 'Скилл добавлен');
    if (ok) onSaved();
  }

  return (
    <div className={section.form}>
      <h2 className={section.formTitle}>Добавить скилл</h2>
      <input
        ref={input}
        type="file"
        accept=".skill"
        hidden
        aria-label="Файл скилла"
        onChange={(e) => {
          const next = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (next) void choose(next);
        }}
      />
      <button type="button" className={styles.drop} onClick={() => input.current?.click()} disabled={busy}>
        <Icon name="file" />
        <span>{file ? file.name : 'Выберите файл .skill'}</span>
        <span className={section.sub}>{busy && !preview ? 'Проверяю архив…' : 'до 10 МБ: папка скилла с SKILL.md'}</span>
      </button>
      <Feedback error={error} />
      {preview ? <Preview preview={preview} /> : null}
      {preview && !preview.exists ? <AccessPicker value={access} onChange={setAccess} departments={departments} users={users} /> : null}
      <div className={section.formActions}>
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="primary" disabled={busy || !preview || (!preview.exists && accessIsEmpty(access))} onClick={() => void save()}>
          {preview?.exists ? 'Заменить' : 'Сохранить'}
        </Button>
      </div>
    </div>
  );
}

export function SkillUpload(props: { departments: AdminDepartment[]; users: AdminUser[]; onClose: () => void; onSaved: () => void }) {
  return (
    <Modal open onClose={props.onClose} label="Добавить скилл">
      <UploadBody {...props} />
    </Modal>
  );
}
