// «Настройки» on the page of an agent (spec, scenario 5; owner's list 16.11): the agent's model — only
// while «Агенты выбирают модель из каталога» is on in «Нейросеть» — and «Что агенту можно». The starter questions of
// the empty chat are gone (owner's decision 24.11).
import type { AdminAgent, PromptState } from '@bba/contracts';
import { ru } from '../i18n/ru.ts';
import { Card, CardHead } from '../ui/Display.tsx';
import { Field, Select } from '../ui/Field.tsx';
import { adminApi } from './api.ts';
import styles from './agents.module.css';
import { Feedback, useAction } from '../ui/form-parts.tsx';
import { AgentAbilities } from './AgentAbilities.tsx';

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
          <option value="">{ru.admin.agents.primaryModel(state.primaryModel)}</option>
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
    <>
      <Card className="rise">
        <CardHead title={ru.admin.agents.settingsTitle} sub={ru.admin.agents.settingsSub} />
        <div className={styles.settingsBody}>
          <AgentModel state={state} onSaved={onChanged} />
        </div>
      </Card>
      <AgentAbilities agent={agent} onChanged={onChanged} />
    </>
  );
}
