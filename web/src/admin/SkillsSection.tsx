// «Скиллы» (spec, scenario 10; mockup; owner's list 16.11): methods for the agents as `.skill` files —
// a list, one card under another, each with what it does (two lines at most), the agents that have it («Агенты:», as in
// the mockup) and a switch; «Добавить скилл», a new version over the old one, the agents, removal after a question.
// A skill has no access of its own (owner's decision 24.11): people get it through an agent; a skill with no agent is
// marked. Scripts run in the sandbox without network. The system skills of the core (section 8.18) come first: built
// in, always on for every agent that may run commands — no switch and no actions.
import type { AdminAgent, SkillDto, SkillsSandbox } from '@bba/contracts';
import { useCallback, useRef, useState } from 'react';
import { Button, IconButton } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { cx } from '../ui/Button.tsx';
import { Card, EmptyState, IconTile, PageHead, Pill } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dateTime, fileSize } from '../i18n/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { Menu, MenuAnchor, MenuItem, MenuSeparator } from '../ui/Menu.tsx';
import { Modal } from '../ui/Modal.tsx';
import { Switch } from '../ui/Switch.tsx';
import { useLoad } from '../ui/use-load.ts';
import { ru } from '../i18n/ru.ts';
import { adminApi } from './api.ts';
import { Feedback, useAction } from '../ui/form-parts.tsx';
import section from './section.module.css';
import { SkillAgentsPicker } from './SkillAgentsPicker.tsx';
import { SkillUpload } from './SkillUpload.tsx';
import styles from './skills.module.css';

const ta = ru.admin.agents.access.skillAgents;

function AgentsDialog({ skill, agents, onClose, onSaved }: { skill: SkillDto; agents: AdminAgent[]; onClose: () => void; onSaved: () => void }) {
  const [agentIds, setAgentIds] = useState(skill.agentIds.filter((id) => agents.some((a) => a.id === id)));
  const { busy, error, run } = useAction();
  return (
    <Modal open onClose={onClose} label={ta.dialog(skill.title)}>
      <div className={section.form}>
        <h2 className={section.formTitle}>{skill.title}</h2>
        <Feedback error={error} />
        <SkillAgentsPicker agents={agents} value={agentIds} onChange={setAgentIds} />
        {agentIds.length === 0 ? <p className={section.note}>{ta.noneHint}</p> : null}
        <div className={section.formActions}>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" disabled={busy} onClick={() => void run(() => adminApi.updateSkill(skill.name, { agentIds }), ta.saved).then((ok) => ok && onSaved())}>
            Сохранить
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// «Агенты:» of a skill: the names of the installation's agents, or a marked «не выбраны».
function SkillAgentsLine({ skill, agents }: { skill: SkillDto; agents: AdminAgent[] }) {
  const names = skill.system ? ta.all : agents.filter((a) => skill.agentIds.includes(a.id)).map((a) => a.name).join(', ');
  return (
    <div className={styles.meta}>
      <span className={section.sub}>{ta.label}</span> <span className={cx(styles.who, !names && styles.whoNone)}>{names || ta.none}</span>
    </div>
  );
}

function SystemSkillCard({ skill, agents }: { skill: SkillDto; agents: AdminAgent[] }) {
  return (
    <Card className={`${styles.card} rise`}>
      <div className={styles.head} data-skill={skill.name}>
        <IconTile icon={skill.hasScripts ? 'term' : 'layers'} size={36} />
        <div className={styles.title}>
          <div className={styles.name}>{skill.title}</div>
          <div className={styles.pills}>
            <Pill>{skill.name}</Pill>
            <Pill tone="accent">{ru.admin.skills.system}</Pill>
          </div>
        </div>
      </div>
      <p className={styles.desc} title={skill.description}>
        {skill.description}
      </p>
      <SkillAgentsLine skill={skill} agents={agents} />
      <div className={section.sub}>
        {fileSize(skill.sizeBytes)} · {ru.admin.skills.builtIn}
      </div>
    </Card>
  );
}

function SandboxNote({ sandbox }: { sandbox: SkillsSandbox }) {
  const t = ru.admin.skills;
  return (
    <div className={section.note}>
      <p className={styles.sandboxLead}>{t.sandboxLead}</p>
      <ul className={styles.sandbox}>
        <li>{t.sandboxPrograms(sandbox.programs.join(', '))}</li>
        <li>{t.sandboxPython(sandbox.python.join(', '))}</li>
        <li>{t.sandboxNode(sandbox.node.join(', '))}</li>
      </ul>
    </div>
  );
}

function SkillCard({ skill, agents, onAgents, onChanged }: { skill: SkillDto; agents: AdminAgent[]; onAgents: () => void; onChanged: () => void }) {
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
      <div className={styles.head} data-skill={skill.name}>
        <IconTile icon={skill.hasScripts ? 'term' : 'layers'} size={36} />
        <div className={styles.title}>
          <div className={styles.name}>{skill.title}</div>
          <Pill>{skill.name}</Pill>
        </div>
        <Switch checked={skill.enabled} disabled={busy} label={skill.title} onChange={(on) => void act(() => adminApi.updateSkill(skill.name, { enabled: on }), on ? 'Скилл включён' : 'Скилл выключен')} />
        <MenuAnchor>
          <IconButton icon="dots" label={label} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} />
          <Menu open={open} onClose={() => setOpen(false)} label={label} width={230}>
            <MenuItem icon="users" onSelect={() => (setOpen(false), onAgents())}>
              {ta.menu}
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
      <p className={styles.desc} title={skill.description}>
        {skill.description}
      </p>
      <SkillAgentsLine skill={skill} agents={agents} />
      <div className={section.sub}>
        {fileSize(skill.sizeBytes)}
        {skill.uploadedAt ? ` · загружен ${dateTime(skill.uploadedAt)}` : ''}
        {skill.uploadedBy ? ` · ${skill.uploadedBy}` : ''}
      </div>
      <Feedback error={error} />
    </Card>
  );
}

export function SkillsSection() {
  const load = useCallback(async () => {
    const [skills, agents] = await Promise.all([adminApi.skills(), adminApi.agents()]);
    return { ...skills, agents: agents.agents };
  }, []);
  const { state, reload } = useLoad(load, ['admin', 'skills-page']);
  const [adding, setAdding] = useState(false);
  const [agentsOf, setAgentsOf] = useState<string | null>(null);
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
  if (state.status === 'loading') return <div className={section.stack}>{head}<DelayedBar /></div>;
  if (state.status === 'error') return <div className={section.stack}>{head}<ErrorBanner error={state.error} onRetry={reload} /></div>;
  const { skills, sandbox, agents } = state.data;
  const editing = skills.find((s) => s.name === agentsOf && !s.system) ?? null;
  const own = skills.filter((s) => !s.system);
  return (
    <div className={section.stack}>
      {head}
      <ul className={styles.list} aria-label="Скиллы">
        {skills.map((s) => (
          <li key={s.name}>
            {s.system ? <SystemSkillCard skill={s} agents={agents} /> : <SkillCard skill={s} agents={agents} onAgents={() => setAgentsOf(s.name)} onChanged={reload} />}
          </li>
        ))}
      </ul>
      {own.length === 0 ? (
        <Card>
          <EmptyState title={ru.admin.skills.noOwnTitle} text={ru.admin.skills.noOwnText} />
        </Card>
      ) : null}
      <SandboxNote sandbox={sandbox} />
      {adding ? (
        <SkillUpload
          agents={agents}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
        />
      ) : null}
      {editing ? (
        <AgentsDialog
          skill={editing}
          agents={agents}
          onClose={() => setAgentsOf(null)}
          onSaved={() => {
            setAgentsOf(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}
