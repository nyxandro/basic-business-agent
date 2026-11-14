// «Расходы» (spec, scenario 5): spend by employees, agents, models or accounts for a period.
import { USAGE_GROUPS, type UsageGroup } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dateTime, rub } from '../ui/format.ts';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { monthStart, today } from './dates.ts';

const GROUP_LABELS: Record<UsageGroup, string> = { user: 'по сотрудникам', agent: 'по агентам', model: 'по моделям', deployment: 'по аккаунтам и ключам' };

export function UsageSection() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [groupBy, setGroupBy] = useState<UsageGroup>('user');
  const load = useCallback(() => adminApi.usage(from, to, groupBy), [from, to, groupBy]);
  const { state, reload } = useLoad(load);
  return (
    <div>
      <h1>Расходы</h1>
      <div className="filters">
        <label>
          С
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          По
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Показать
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as UsageGroup)}>
            {USAGE_GROUPS.map((g) => (
              <option key={g} value={g}>
                {GROUP_LABELS[g]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {state.status === 'loading' ? <Skeleton rows={3} /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? (
        <>
          <p>
            Всего: {rub(state.data.totalRub)}
            {state.data.orgLimitRub !== null ? ` из ${rub(state.data.orgLimitRub)} в месяц` : ''}
          </p>
          {state.data.rows.length === 0 ? <p className="empty">За этот период расходов нет.</p> : null}
          {state.data.rows.length > 0 ? (
            <div className="table-scroll">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th scope="col">Кто или что</th>
                    <th scope="col">Запросов</th>
                    <th scope="col">Токенов (вход / выход)</th>
                    <th scope="col">Сумма</th>
                    <th scope="col">Последний запрос</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.rows.map((r) => (
                    <tr key={r.key}>
                      <td>{r.label}</td>
                      <td>{r.calls.toLocaleString('ru-RU')}</td>
                      <td>
                        {r.inputTokens.toLocaleString('ru-RU')} / {r.outputTokens.toLocaleString('ru-RU')}
                      </td>
                      <td>{rub(r.costRub)}</td>
                      <td>{r.lastCallAt ? dateTime(r.lastCallAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
