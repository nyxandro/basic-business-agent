// «Настройки» on the page of an agent (spec, scenario 5; owner's list 16.11): the agent's model — only
// while «Агенты выбирают модель из каталога» is on in «Нейросеть» — and the starter questions of
// the empty chat, the admin's over the passport's.
import type { AdminAgent, PromptState } from '@bba/contracts';
import { useState } from 'react';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { Card, CardHead } from '../ui/Display.tsx';
import { Field, Input, Select } from '../ui/Field.tsx';
import { adminApi } from './api.ts';
import styles from './agents.module.css';
import { Feedback, useAction } from './parts.tsx';

const MAX_STARTERS = 3;
const STARTER_SEPARATOR = ';';

const startersText = (list: string[]) => list.join(`${STARTER_SEPARATOR} `);
const startersOf = (text: string) =>
  text
    .split(STARTER_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);

function Starters({ agent, onSaved }: { agent: AdminAgent; onSaved: () => void }) {
  const [text, setText] = useState(startersText(agent.starters));
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const dirty = text !== startersText(agent.starters);
  async function save() {
    const list = startersOf(text);
    if (list.length > MAX_STARTERS) return setProblem(`Не больше ${MAX_STARTERS} подсказок.`);
    setProblem(null);
    if (await run(() => adminApi.setStarters(agent.id, list))) onSaved();
  }
  async function reset() {
    if (await run(() => adminApi.setStarters(agent.id, null), 'Подсказки из файла')) onSaved();
  }
  return (
    <div className={styles.starters}>
      <Field label="Подсказки в пустом чате" hint="До трёх, через точку с запятой." error={problem}>
        <Input value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Feedback error={error} />
      <div className={styles.inline}>
        {agent.startersCustom ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void reset()}>
            Вернуть подсказки из файла
          </Button>
        ) : null}
        {dirty ? (
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            Сохранить подсказки
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function AgentModel({ state, onSaved }: { state: PromptState; onSaved: () => void }) {
  const { busy, error, run } = useAction();
  const off = state.allowedModels.length === 0;
  async function change(value: string) {
    if (await run(() => adminApi.setModel(state.agentId, value || null))) onSaved();
  }
  return (
    <div>
      <Field label="Модель агента" hint={off ? 'Выбор модели выключен: включите «Агенты выбирают модель из каталога» в разделе «Нейросеть».' : undefined}>
        <Select value={state.modelId ?? ''} disabled={off || busy} onChange={(e) => void change(e.target.value)}>
          <option value="">Основная организации</option>
          {state.allowedModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
      <Feedback error={error} />
    </div>
  );
}

export function AgentSettings({ agent, state, onChanged }: { agent: AdminAgent; state: PromptState; onChanged: () => void }) {
  return (
    <Card className="rise">
      <CardHead title={ru.admin.agents.settingsTitle} sub={ru.admin.agents.settingsSub} />
      <div className={styles.settingsBody}>
        <AgentModel state={state} onSaved={onChanged} />
        <Starters key={agent.starters.join('|')} agent={agent} onSaved={onChanged} />
      </div>
    </Card>
  );
}
