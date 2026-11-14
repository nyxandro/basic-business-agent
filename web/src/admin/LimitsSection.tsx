// «Лимиты» (spec, scenario 5, F5): the organisation ceiling, the default per employee, the daily
// token cap of subscription models, and personal limits on top of the defaults.
import type { AdminUser, LimitSettingsBody, PersonalLimit } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { fromField, toField } from './numbers.ts';
import { Feedback, useAction } from './parts.tsx';

const INVALID = 'Нужно число не меньше нуля; для токенов — целое.';

function OrgLimits({ initial, onSaved }: { initial: LimitSettingsBody; onSaved: () => void }) {
  const [org, setOrg] = useState(toField(initial.orgMonthlyRub));
  const [user, setUser] = useState(toField(initial.defaultUserMonthlyRub));
  const [daily, setDaily] = useState(toField(initial.defaultDailySubscriptionTokens));
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, error, notice, run } = useAction();
  const save = async () => {
    const values = [fromField(org, 'rub'), fromField(user, 'rub'), fromField(daily, 'tokens')];
    if (values.includes('invalid')) return setProblem(INVALID);
    setProblem(null);
    const [orgMonthlyRub, defaultUserMonthlyRub, defaultDailySubscriptionTokens] = values as (number | null)[];
    if (await run(() => adminApi.saveLimits({ orgMonthlyRub: orgMonthlyRub!, defaultUserMonthlyRub: defaultUserMonthlyRub!, defaultDailySubscriptionTokens: defaultDailySubscriptionTokens! }))) onSaved();
  };
  return (
    <div className="admin-form">
      <Feedback error={error} notice={notice} />
      <label>
        Общий потолок организации в месяц, ₽ (пусто — без потолка)
        <input inputMode="decimal" value={org} onChange={(e) => setOrg(e.target.value)} />
      </label>
      <label>
        Лимит сотрудника по умолчанию в месяц, ₽ (пусто — без лимита)
        <input inputMode="decimal" value={user} onChange={(e) => setUser(e.target.value)} />
      </label>
      <label>
        Дневной потолок подписочных моделей, токенов (пусто — без потолка)
        <input inputMode="numeric" value={daily} onChange={(e) => setDaily(e.target.value)} />
      </label>
      {problem ? <p className="field-error">{problem}</p> : null}
      <button type="button" disabled={busy} onClick={() => void save()}>
        Сохранить
      </button>
    </div>
  );
}

function PersonalRow({ user, limit }: { user: AdminUser; limit: PersonalLimit | undefined }) {
  const [monthly, setMonthly] = useState(toField(limit?.monthlyRub ?? null));
  const [daily, setDaily] = useState(toField(limit?.dailySubscriptionTokens ?? null));
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, error, notice, run } = useAction();
  const save = () => {
    const m = fromField(monthly, 'rub');
    const d = fromField(daily, 'tokens');
    if (m === 'invalid' || d === 'invalid') return setProblem(INVALID);
    setProblem(null);
    void run(() => adminApi.savePersonalLimit(user.id, m, d));
  };
  return (
    <tr>
      <td>
        {user.name}
        <Feedback error={error} notice={notice} />
        {problem ? <p className="field-error">{problem}</p> : null}
      </td>
      <td>
        <input aria-label={`Лимит в месяц, ₽: ${user.name}`} inputMode="decimal" placeholder="по умолчанию" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
      </td>
      <td>
        <input aria-label={`Токенов в день: ${user.name}`} inputMode="numeric" placeholder="по умолчанию" value={daily} onChange={(e) => setDaily(e.target.value)} />
      </td>
      <td>
        <button type="button" disabled={busy} onClick={save}>
          Сохранить
        </button>
      </td>
    </tr>
  );
}

export function LimitsSection() {
  const load = useCallback(async () => {
    const [limits, personal, users] = await Promise.all([adminApi.limits(), adminApi.personalLimits(), adminApi.users()]);
    return { limits, personal: personal.users, users: users.users };
  }, []);
  const { state, reload } = useLoad(load);
  if (state.status === 'loading') return <Skeleton rows={3} />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const personal = new Map(state.data.personal.map((p) => [p.userId, p]));
  return (
    <div>
      <h1>Лимиты</h1>
      <OrgLimits initial={state.data.limits} onSaved={reload} />
      <h2>Личные лимиты</h2>
      <p className="muted">Пустое поле — действует лимит по умолчанию.</p>
      <div className="table-scroll">
        <table className="admin-table">
          <thead>
            <tr>
              <th scope="col">Сотрудник</th>
              <th scope="col">В месяц, ₽</th>
              <th scope="col">Токенов в день</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {state.data.users.map((u) => (
              <PersonalRow key={u.id} user={u} limit={personal.get(u.id)} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
