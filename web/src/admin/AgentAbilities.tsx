// «Что агенту можно» on the page of an agent (spec, sections 8.30 and 8.31): the internet, the commands of the sandbox
// and the widgets in the chat.
// A switch saves at once; on a failure it stays as it was and the error shows under the card.
import type { AdminAgent, AgentAbilities as Abilities } from '@bba/contracts';
import { useState } from 'react';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Card, CardHead } from '../ui/Display.tsx';
import { Switch } from '../ui/Switch.tsx';
import { adminApi } from './api.ts';
import styles from './agents.module.css';
import { Feedback, useAction } from '../ui/form-parts.tsx';
import section from './section.module.css';

const t = ru.admin.agents.abilities;

const ROWS: { key: keyof Abilities; title: string; sub: string }[] = [
  { key: 'web', title: t.web, sub: t.webSub },
  { key: 'commands', title: t.commands, sub: t.commandsSub },
  { key: 'widgets', title: t.widgets, sub: t.widgetsSub },
];

export function AgentAbilities({ agent, onChanged }: { agent: AdminAgent; onChanged: () => void }) {
  const [abilities, setAbilities] = useState(agent.abilities);
  const { busy, error, run } = useAction();
  async function change(key: keyof Abilities, on: boolean) {
    const saved = await run(async () => setAbilities((await adminApi.setAbilities(agent.id, { [key]: on })).abilities));
    if (saved) onChanged();
  }
  return (
    <Card className={cx(styles.abilities, 'rise')}>
      <CardHead title={t.title} sub={t.sub} />
      <div className={styles.abilityList}>
        {ROWS.map((row) => (
          <div key={row.key} className={styles.abilityRow}>
            <div className={styles.abilityText}>
              <div className={styles.abilityTitle}>{row.title}</div>
              <div className={section.sub}>{row.sub}</div>
            </div>
            <Switch size="lg" checked={abilities[row.key]} disabled={busy} label={row.title} onChange={(on) => void change(row.key, on)} />
          </div>
        ))}
        <Feedback error={error} />
      </div>
    </Card>
  );
}
