// The prompt of an agent (spec, scenario 5): an edit over instructions.md → a draft → «Проверить
// в чате» → «Опубликовать». A conflicting edit keeps the person's text in the field.
import type { PromptState } from '@bba/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { adminApi } from './api.ts';
import { Feedback, useAction } from './parts.tsx';

// `onChanged` reloads the prompt; the editor is then recreated, so the result text lives above it.
export function PromptEditor({ state, onChanged }: { state: PromptState; onChanged: (done: string) => void }) {
  const [text, setText] = useState(state.draftInstructions ?? state.publishedInstructions ?? state.fileInstructions);
  const [base, setBase] = useState(state.draftVersionId);
  const [model, setModel] = useState(state.modelId ?? '');
  const { busy, error, notice, run } = useAction();
  const id = state.agentId;

  const saveDraft = () => run(async () => setBase((await adminApi.saveDraft(id, text, base)).draftVersionId), 'Черновик сохранён');
  const publish = async () => {
    if (await run(() => adminApi.publish(id))) onChanged('Опубликовано');
  };
  const revert = async () => {
    if (!window.confirm('Вернуть промпт из файла instructions.md? Правка из админки перестанет действовать.')) return;
    if (await run(() => adminApi.revert(id))) onChanged('Возвращена версия из файла');
  };

  return (
    <div className="admin-form prompt-editor">
      <div className="marks">
        {state.publishedInstructions !== null ? <span className="mark">Изменён в админке</span> : null}
        {state.fileChangedSincePublish ? <span className="mark mark-warn">Файл изменён после правки в админке</span> : null}
        {state.draftBy ? <span className="muted">Черновик правил(а): {state.draftBy}</span> : null}
      </div>
      <Feedback error={error} notice={notice} />
      <label>
        Промпт агента
        <textarea rows={14} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="row-buttons">
        <button type="button" disabled={busy} onClick={() => void saveDraft()}>
          Сохранить черновик
        </button>
        <Link className="button-link" to={`/admin/agents/${encodeURIComponent(id)}/check`}>
          Проверить в чате
        </Link>
        <button type="button" disabled={busy || base === null} onClick={() => void publish()}>
          Опубликовать
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void revert()}>
          Вернуть версию из файла
        </button>
      </div>
      <p className="muted">В чате проверяется сохранённый черновик; правила ядра действуют всегда.</p>
      {state.allowedModels.length > 0 ? (
        <div className="row-buttons">
          <label>
            Модель агента
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">как в паспорте агента</option>
              {state.allowedModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={busy} onClick={() => void run(() => adminApi.setModel(id, model || null))}>
            Сохранить модель
          </button>
        </div>
      ) : null}
    </div>
  );
}
