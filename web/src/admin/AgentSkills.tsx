// «Скиллы» on the page of an agent (owner's decision 24.11, spec section 8.15): the uploaded skills of the base ticked for
// the agent — the same link as «Агенты» of a skill in «Скиллы». The system skills of documents are not ticked: they are
// with every agent that may run commands, and the card says whether this one may.
import type { AdminAgent, SkillDto } from '@bba/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { useMe } from '../auth/session.tsx';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { Card, CardHead } from '../ui/Display.tsx';
import { Checklist, Feedback, useAction } from '../ui/form-parts.tsx';
import { adminApi } from './api.ts';
import styles from './agents.module.css';
import section from './section.module.css';

const t = ru.admin.agents.access.skills;

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export function AgentSkills({ agent, skills, onChanged }: { agent: AdminAgent; skills: SkillDto[]; onChanged: () => void }) {
  const me = useMe();
  const [chosen, setChosen] = useState(agent.skillNames);
  const { busy, error, run } = useAction();
  const system = skills.filter((s) => s.system);
  const uploaded = skills.filter((s) => !s.system);
  const dirty = !sameList(chosen, agent.skillNames);
  const systemNames = system.map((s) => `«${s.title}»`).join(', ');
  const canOpenSkills = me.isSuperadmin || me.permissions.includes('skills');

  async function save() {
    if (await run(() => adminApi.setAgentSkills(agent.id, chosen), t.saved)) onChanged();
  }

  return (
    <Card className="rise">
      <CardHead title={t.title} sub={t.sub} />
      <div className={styles.settingsBody}>
        {uploaded.length > 0 ? (
          <Checklist legend={t.legend} items={uploaded.map((s) => ({ id: s.name, label: s.enabled ? s.title : `${s.title} — ${t.off}` }))} selected={chosen} onChange={setChosen} />
        ) : (
          <div className={styles.inline}>
            <p className={section.note}>{t.empty}</p>
            {canOpenSkills ? (
              <Link to="/admin/skills" className={styles.back}>
                {t.open}
              </Link>
            ) : null}
          </div>
        )}
        {system.length > 0 ? <p className={section.sub}>{agent.abilities.commands ? t.systemOn(systemNames) : t.systemOff(systemNames)}</p> : null}
        <Feedback error={error} />
        {dirty ? (
          <div className={styles.inline}>
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              {t.save}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
