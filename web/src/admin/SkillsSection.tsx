// «Скиллы» (spec, scenario 10; mockup): methods for the agents as `.skill` files — a card each with
// what it does, who has it and a switch; «Добавить скилл», a new version over the old one, who has
// it, removal after a question. Scripts run in the sandbox without network.
import type { AdminDepartment, AdminPerson, SkillAccess, SkillDto } from '@bba/contracts';
import { useCallback, useRef, useState } from 'react';
import { Button, IconButton } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, EmptyState, IconTile, PageHead, Pill } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dateTime, fileSize } from '../ui/format.ts';
import { Skeleton } from '../ui/Loading.tsx';
import { Menu, MenuAnchor, MenuItem, MenuSeparator } from '../ui/Menu.tsx';
import { Modal } from '../ui/Modal.tsx';
import { Switch } from '../ui/Switch.tsx';
import { useLoad } from '../ui/use-load.ts';
import { AccessPicker, accessIsEmpty, accessText } from './AccessPicker.tsx';
import { adminApi } from './api.ts';
import { Feedback, useAction } from './parts.tsx';
import section from './section.module.css';
import { SkillUpload } from './SkillUpload.tsx';
import styles from './skills.module.css';

function AccessDialog({ skill, departments, users, onClose, onSaved }: { skill: SkillDto; departments: AdminDepartment[]; users: AdminPerson[]; onClose: () => void; onSaved: () => void }) {
  const [access, setAccess] = useState<SkillAccess>(skill.access);
  const { busy, error, run } = useAction();
  return (
    <Modal open onClose={onClose} label={`Кому доступен: ${skill.title}`}>
      <div className={section.form}>
        <h2 className={section.formTitle}>{skill.title}</h2>
        <Feedback error={error} />
        <AccessPicker value={access} onChange={setAccess} departments={departments} users={users} />
        <div className={section.formActions}>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" disabled={busy || accessIsEmpty(access)} onClick={() => void run(() => adminApi.updateSkill(skill.name, { access })).then((ok) => ok && onSaved())}>
            Сохранить
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SkillCard({ skill, who, onAccess, onChanged }: { skill: SkillDto; who: string; onAccess: () => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();
  const { busy, error, run } = useAction();
  const label = `Действия: ${skill.title}`;
  const act = async (action: () => Promise<unknown>, done: string) => {
    if (await run(action, done)) onChanged();
  };
  return (
    <Card className={`${styles.card} rise`}>
      <div className={styles.head}>
        <IconTile icon={skill.hasScripts ? 'term' : 'layers'} size={36} />
        <div className={styles.title}>
          <div className={styles.name}>{skill.title}</div>
          <Pill>{skill.name}</Pill>
        </div>
        <Switch checked={skill.enabled} disabled={busy} label={skill.title} onChange={(on) => void act(() => adminApi.updateSkill(skill.name, { enabled: on }), on ? 'Скилл включён' : 'Скилл выключен')} />
        <MenuAnchor>
          <IconButton icon="dots" label={label} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} />
          <Menu open={open} onClose={() => setOpen(false)} label={label} width={230}>
            <MenuItem icon="users" onSelect={() => (setOpen(false), onAccess())}>
              Кому доступен
            </MenuItem>
            <MenuItem icon="redo" onSelect={() => (setOpen(false), file.current?.click())}>
              Заменить версию
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon="trash"
              danger
              onSelect={() => {
                setOpen(false);
                void confirm({ title: `Удалить скилл «${skill.title}»?`, text: 'Агенты перестанут им пользоваться. Ответ, который идёт сейчас, доработает со старой копией.', confirmLabel: 'Удалить', danger: true }).then(async (yes) => {
                  if (yes) await act(() => adminApi.deleteSkill(skill.name), 'Скилл удалён');
                });
              }}
            >
              Удалить
            </MenuItem>
          </Menu>
        </MenuAnchor>
      </div>
      <input
        ref={file}
        type="file"
        accept=".skill"
        hidden
        aria-label={`Новая версия: ${skill.title}`}
        onChange={(e) => {
          const next = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (next) void act(() => adminApi.replaceSkill(skill.name, next), 'Скилл заменён');
        }}
      />
      <p className={styles.desc}>{skill.description}</p>
      <div className={styles.meta}>
        <span className={section.sub}>Кому:</span> <span className={styles.who}>{who}</span>
      </div>
      <div className={section.sub}>
        {fileSize(skill.sizeBytes)} · загружен {dateTime(skill.uploadedAt)}
        {skill.uploadedBy ? ` · ${skill.uploadedBy}` : ''}
      </div>
      <Feedback error={error} />
    </Card>
  );
}

export function SkillsSection() {
  const load = useCallback(async () => {
    const [skills, departments, users] = await Promise.all([adminApi.skills(), adminApi.departments(), adminApi.people()]);
    return { ...skills, departments: departments.departments, users: users.people };
  }, []);
  const { state, reload } = useLoad(load);
  const [adding, setAdding] = useState(false);
  const [accessOf, setAccessOf] = useState<string | null>(null);
  const head = (
    <PageHead
      title="Скиллы"
      lead="Методики для агентов. Скрипты скиллов выполняются в песочнице: своя папка у каждого сотрудника, без сети."
      actions={
        <Button variant="primary" icon="plus" disabled={state.status !== 'ready'} onClick={() => setAdding(true)}>
          Добавить скилл
        </Button>
      }
    />
  );
  if (state.status === 'loading') return <div className={section.stack}>{head}<Skeleton rows={4} /></div>;
  if (state.status === 'error') return <div className={section.stack}>{head}<ErrorBanner error={state.error} onRetry={reload} /></div>;
  const { skills, libraries, departments, users } = state.data;
  const editing = skills.find((s) => s.name === accessOf) ?? null;
  return (
    <div className={section.stack}>
      {head}
      {skills.length === 0 ? (
        <Card>
          <EmptyState title="Скиллов пока нет" text="Добавьте файл .skill — папку с SKILL.md и, если нужно, скриптами." />
        </Card>
      ) : (
        <div className={styles.grid}>
          {skills.map((s) => (
            <SkillCard key={s.name} skill={s} who={accessText(s.access, departments, users)} onAccess={() => setAccessOf(s.name)} onChanged={reload} />
          ))}
        </div>
      )}
      {libraries.length > 0 ? <p className={section.note}>В песочнице есть библиотеки Python: {libraries.join(', ')}.</p> : null}
      {adding ? (
        <SkillUpload
          departments={departments}
          users={users}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
        />
      ) : null}
      {editing ? (
        <AccessDialog
          skill={editing}
          departments={departments}
          users={users}
          onClose={() => setAccessOf(null)}
          onSaved={() => {
            setAccessOf(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}
