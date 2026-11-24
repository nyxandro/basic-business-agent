// «Инструкции» on the page of an agent (spec, scenario 5; mockup; owner's list 16.11): how the prompt
// is put together, the prompt as an edit over instructions.md → a draft → «Проверить в чате» →
// «Опубликовать». A conflicting edit keeps the person's text in the field. The agent's model and
// «Что агенту можно» are «Настройки» (AgentSettings.tsx), its mark — «Значок».
import type { PromptState } from '@bba/contracts';
import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, Pill } from '../ui/Display.tsx';
import { Field, TextArea } from '../ui/Field.tsx';
import { Icon } from '../ui/Icon.tsx';
import { adminApi } from './api.ts';
import styles from './agents.module.css';
import { Feedback, useAction } from '../ui/form-parts.tsx';

// The order the server puts the layers in on every request (spec, section 9).
const LAYERS = ['Правила ядра', 'Промпт агента', 'Профиль организации', 'Профиль сотрудника', 'Проект: память, разговоры, файлы', 'Личная память'];
const EDITED_LAYER = 'Промпт агента';

function status(state: PromptState): { text: string; tone: 'accent' | 'warn' | 'neutral' } {
  if (state.draftVersionId) return { text: 'Черновик', tone: 'accent' };
  if (state.publishedInstructions !== null) return { text: 'Изменён в админке', tone: 'warn' };
  return { text: 'Из файла агента', tone: 'neutral' };
}

// `onChanged` reloads the agent; the editor is then recreated with the fresh version.
export function AgentInstructions({ state, onChanged }: { state: PromptState; onChanged: () => void }) {
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
        <h2 className={styles.editorTitle}>{ru.admin.agents.tabs.instructions}</h2>
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
