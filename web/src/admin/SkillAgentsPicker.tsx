// The agents of a skill (owner's decision 24.11, spec section 8.15): the installation's agents to tick, at the upload
// and in «Агенты» of a skill. An agent the installation no longer has is not shown; the server keeps its link.
import type { AdminAgent } from '@bba/contracts';
import { ru } from '../i18n/ru.ts';
import { Checklist } from '../ui/form-parts.tsx';
import section from './section.module.css';

const t = ru.admin.agents.access.skillAgents;

export function SkillAgentsPicker({ agents, value, onChange }: { agents: AdminAgent[]; value: string[]; onChange: (next: string[]) => void }) {
  if (agents.length === 0) return <p className={section.note}>{t.noAgents}</p>;
  return <Checklist legend={t.legend} items={agents.map((a) => ({ id: a.id, label: a.name }))} selected={value.filter((id) => agents.some((a) => a.id === id))} onChange={onChange} />;
}
