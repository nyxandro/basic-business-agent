// «Маскирование» (spec, sections 8.11 and 12): which personal data the model sees as a placeholder.
import { MASKING_KIND_IDS } from '@bba/contracts';
import { useState } from 'react';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { Checklist, Feedback, useAction } from './parts.tsx';

const KIND_LABELS: Record<(typeof MASKING_KIND_IDS)[number], string> = {
  passport: 'Паспорт РФ',
  snils: 'СНИЛС',
  card: 'Номер банковской карты',
  inn: 'ИНН',
  phone: 'Телефон',
  email: 'Электронная почта',
};
const KINDS = MASKING_KIND_IDS.map((id) => ({ id, label: KIND_LABELS[id] }));

function MaskingForm({ initial }: { initial: string[] }) {
  const [kinds, setKinds] = useState(initial);
  const { busy, error, notice, run } = useAction();
  return (
    <div className="admin-form">
      <Feedback error={error} notice={notice} />
      <Checklist legend="Скрывать от модели" items={KINDS} selected={kinds} onChange={setKinds} />
      <p className="muted">Модель видит заглушку вроде [ПОЧТА_1], а письма и таблицы получают настоящие данные. Картинки и сканы уходят в модель как есть.</p>
      <button type="button" disabled={busy} onClick={() => void run(() => adminApi.saveMasking(kinds))}>
        Сохранить
      </button>
    </div>
  );
}

export function MaskingSection() {
  const { state, reload } = useLoad(adminApi.masking);
  return (
    <div>
      <h1>Маскирование</h1>
      {state.status === 'loading' ? <Skeleton rows={2} /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? <MaskingForm initial={state.data.kinds} /> : null}
    </div>
  );
}
