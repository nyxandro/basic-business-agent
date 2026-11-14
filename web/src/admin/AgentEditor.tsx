// The editor of one agent (spec, scenario 5; mockup): how the prompt is put together, the prompt
// as an edit over instructions.md → a draft → «Проверить в чате» → «Опубликовать»; the agent's
// model (only while agents may choose one) and the starter questions of the empty chat. A
// conflicting edit keeps the person's text in the field.
import type { AdminAgent, PromptState } from '@bba/contracts';
import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, Pill } from '../ui/Display.tsx';
import { Field, Input, Select, TextArea } from '../ui/Field.tsx';
import { Icon } from '../ui/Icon.tsx';
import { adminApi } from './api.ts';
import styles from './agents.module.css';
import { Feedback, useAction } from './parts.tsx';

// The order the server puts the layers in on every request (spec, section 9).
const LAYERS = ['Правила ядра', 'Промпт агента', 'Профиль организации', 'Профиль сотрудника', 'Проект', 'Личная память'];
const EDITED_LAYER = 'Промпт агента';
const MAX_STARTERS = 3;
const STARTER_SEPARATOR = ';';

const startersText = (list: string[]) => list.join(`${STARTER_SEPARATOR} `);
const startersOf = (text: string) =>
  text
    .split(STARTER_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);

function status(state: PromptState): { text: string; tone: 'accent' | 'warn' | 'neutral' } {
  if (state.draftVersionId) return { text: 'Черновик', tone: 'accent' };
  if (state.publishedInstructions !== null) return { text: 'Изменён в админке', tone: 'warn' };
  return { text: 'Из файла агента', tone: 'neutral' };
}

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

// `onChanged` reloads the agent; the editor is then recreated with the fresh version.
export function AgentEditor({ agent, state, onChanged }: { agent: AdminAgent; state: PromptState; onChanged: () => void }) {
  const [text, setText] = useState(state.draftInstructions ?? state.publishedInstructions ?? state.fileInstructions);
  const [base, setBase] = useState(state.draftVersionId);
  const { busy, error, run } = useAction();
  const confirm = useConfirm();
  const id = state.agentId;
  const shown = status(state);

  const saveDraft = () => run(async () => setBase((await adminApi.saveDraft(id, text, base)).draftVersionId), 'Черновик сохранён');
  const publish = async () => {
    if (await run(() => adminApi.publish(id), 'Опубликовано')) onChanged();
  };
  const revert = async () => {
    if (!(await confirm({ title: 'Вернуть промпт из файла?', text: 'Правка из админки перестанет действовать, агент снова возьмёт промпт из instructions.md.', confirmLabel: 'Вернуть', danger: true }))) return;
    if (await run(() => adminApi.revert(id), 'Возвращена версия из файла')) onChanged();
  };

  return (
    <Card className={`${styles.editor} rise`}>
      <div className={styles.editorHead}>
        <h2 className={styles.editorTitle}>{agent.name}</h2>
        <Pill tone={shown.tone}>{shown.text}</Pill>
        {state.fileChangedSincePublish ? <Pill tone="warn">Файл изменён после правки в админке</Pill> : null}
      </div>
      <div>
        <div className={styles.layersTitle}>Как собирается промпт при каждом запросе</div>
        <ol className={styles.layers} aria-label="Слои промпта">
          {LAYERS.map((l, i) => (
            <Fragment key={l}>
              <li className={l === EDITED_LAYER ? styles.layerOn : styles.layer}>{l}</li>
              {i < LAYERS.length - 1 ? <Icon name="right" size={14} className={styles.arrow} /> : null}
            </Fragment>
          ))}
        </ol>
      </div>
      <Feedback error={error} />
      <Field label="Промпт агента" hint={state.draftBy ? `Черновик правил(а): ${state.draftBy}. В чате проверяется сохранённый черновик; правила ядра действуют всегда.` : 'В чате проверяется сохранённый черновик; правила ядра действуют всегда.'}>
        <TextArea mono rows={12} value={text} onChange={(e) => setText(e.target.value)} className={styles.prompt} />
      </Field>
      <div className={styles.settings}>
        <AgentModel state={state} onSaved={onChanged} />
        <Starters agent={agent} onSaved={onChanged} />
      </div>
      <div className={styles.footer}>
        <Button variant="ghost" disabled={busy} onClick={() => void revert()}>
          Вернуть версию из файла
        </Button>
        <span className={styles.fill} />
        <Button disabled={busy} onClick={() => void saveDraft()}>
          Сохранить черновик
        </Button>
        <Link className={styles.check} to={`/admin/agents/${encodeURIComponent(id)}/check`}>
          Проверить в чате
        </Link>
        <Button variant="primary" disabled={busy || base === null} onClick={() => void publish()}>
          Опубликовать
        </Button>
      </div>
    </Card>
  );
}
