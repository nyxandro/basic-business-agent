// «Профиль организации» (spec, scenario 5): name, tone, requisites, industry — go into every agent's prompt.
import { useState } from 'react';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { Feedback, useAction } from './parts.tsx';

function ProfileForm({ initial }: { initial: { name: string; tone: string; requisites: string; industry: string } }) {
  const [form, setForm] = useState(initial);
  const { busy, error, notice, run } = useAction();
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((prev) => ({ ...prev, [key]: e.target.value }));
  return (
    <div className="admin-form">
      <p className="muted">Подставляется в промпт всех агентов.</p>
      <Feedback error={error} notice={notice} />
      <label>
        Название организации
        <input value={form.name} onChange={set('name')} />
      </label>
      <label>
        Тон общения
        <textarea rows={3} value={form.tone} onChange={set('tone')} />
      </label>
      <label>
        Реквизиты
        <textarea rows={4} value={form.requisites} onChange={set('requisites')} />
      </label>
      <label>
        Отрасль
        <input value={form.industry} onChange={set('industry')} />
      </label>
      <button type="button" disabled={busy} onClick={() => void run(() => adminApi.saveOrgProfile(form))}>
        Сохранить
      </button>
    </div>
  );
}

export function OrgProfileSection() {
  const { state, reload } = useLoad(adminApi.orgProfile);
  return (
    <div>
      <h1>Профиль организации</h1>
      {state.status === 'loading' ? <Skeleton rows={3} /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? <ProfileForm initial={state.data} /> : null}
    </div>
  );
}
