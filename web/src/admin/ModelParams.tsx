// «Параметры» of «Нейросеть» (spec, section 8.1; mockup): the organisation's main model, the one
// to switch to on a failure, the speech recognition model and whether agents may take their own
// model from the catalog. A change saves at once; a refused one goes back and says why. The main model
// is never left empty by hand: the server puts a model that can answer there (owner's decision 25.11).
import type { ModelDto, ModelSettings } from '@bba/contracts';
import { useState } from 'react';
import { Card } from '../ui/Display.tsx';
import { Field, Select } from '../ui/Field.tsx';
import { Switch } from '../ui/Switch.tsx';
import { adminApi } from './api.ts';
import styles from './models.module.css';
import { Feedback, useAction } from '../ui/form-parts.tsx';
import section from './section.module.css';

export function ModelParams({ models, settings, onSaved }: { models: ModelDto[]; settings: ModelSettings; onSaved: () => void }) {
  const [shown, setShown] = useState(settings);
  const { busy, error, run } = useAction();
  const chat = models.filter((m) => m.kind === 'chat' && m.enabled);
  const speech = models.filter((m) => m.kind === 'transcription' && m.enabled);
  // The server fills an empty primary while a model can answer (owner's decision 25.11): «Не выбрана» is a state, not a choice.
  const noPrimary = !chat.some((m) => m.id === shown.primaryModelId);

  async function change(next: ModelSettings) {
    const before = shown;
    setShown(next);
    if (await run(() => adminApi.saveModelSettings(next))) onSaved();
    else setShown(before);
  }

  return (
    <Card className={styles.card}>
      <h2 className={styles.cardTitle}>Параметры</h2>
      <Feedback error={error} />
      <Field label="Основная модель">
        <Select value={shown.primaryModelId ?? ''} disabled={busy} onChange={(e) => void change({ ...shown, primaryModelId: e.target.value || null })}>
          {noPrimary ? <option value="">Не выбрана — агенты не отвечают</option> : null}
          {chat.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="При сбое переключаться на">
        <Select value={shown.fallbackModelId ?? ''} disabled={busy} onChange={(e) => void change({ ...shown, fallbackModelId: e.target.value || null })}>
          <option value="">Без запасной</option>
          {chat
            .filter((m) => m.id !== shown.primaryModelId)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
        </Select>
      </Field>
      <Field label="Модель распознавания речи">
        <Select value={shown.transcriptionModelId ?? ''} disabled={busy} onChange={(e) => void change({ ...shown, transcriptionModelId: e.target.value || null })}>
          <option value="">Нет — микрофон скрыт</option>
          {speech.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className={styles.switchRow}>
        <div>
          <div className={styles.switchTitle}>Агенты выбирают модель из каталога</div>
          <div className={section.sub}>Если разрешено в паспорте агента; модель агенту выбирают в «Агентах и промптах».</div>
        </div>
        <Switch checked={shown.agentsChooseModel} disabled={busy} label="Агенты выбирают модель из каталога" onChange={(on) => void change({ ...shown, agentsChooseModel: on })} />
      </div>
    </Card>
  );
}
