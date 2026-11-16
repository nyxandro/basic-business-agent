// «Расходы за период» (spec, scenario 5): spend by employees, agents, models or accounts.
import { USAGE_GROUPS, type UsageGroup } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { cx } from '../ui/Button.tsx';
import { Card, EmptyState } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { dateTime, rub } from '../ui/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { numCell, Table } from '../ui/Table.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { monthStart, today } from './dates.ts';
import styles from './limits.module.css';

const GROUP_LABELS: Record<UsageGroup, string> = { user: 'Сотрудники', agent: 'Агенты', model: 'Модели', deployment: 'Аккаунты и ключи' };

export function UsageSection() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [groupBy, setGroupBy] = useState<UsageGroup>('user');
  const load = useCallback(() => adminApi.usage(from, to, groupBy), [from, to, groupBy]);
  const { state, reload } = useLoad(load, ['admin', 'usage', from, to, groupBy]);
  return (
    <Card className={`${styles.card} rise`}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>Расходы за период</h2>
        {state.status === 'ready' ? (
          <span className={styles.total}>
            Всего: {rub(state.data.totalRub)}
            {state.data.orgLimitRub !== null ? ` из ${rub(state.data.orgLimitRub)} в месяц` : ''}
          </span>
        ) : null}
      </div>
      <div className={styles.filters}>
        <Field label="С">
          <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="По">
          <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <div role="group" aria-label="Показать" className={styles.chips}>
          {USAGE_GROUPS.map((g) => (
            <button key={g} type="button" aria-pressed={groupBy === g} className={cx(styles.chip, groupBy === g && styles.chipOn)} onClick={() => setGroupBy(g)}>
              {GROUP_LABELS[g]}
            </button>
          ))}
        </div>
      </div>
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' && state.data.rows.length === 0 ? <EmptyState title="За этот период расходов нет" /> : null}
      {state.status === 'ready' && state.data.rows.length > 0 ? (
        <div className={styles.tableBox}>
          <Table minWidth={620} label="Расходы за период">
            <thead>
              <tr>
                <th scope="col">{GROUP_LABELS[groupBy]}</th>
                <th scope="col" className={numCell}>
                  Запросов
                </th>
                <th scope="col" className={numCell}>
                  Токенов (вход / выход)
                </th>
                <th scope="col" className={numCell}>
                  Сумма
                </th>
                <th scope="col">Последний запрос</th>
              </tr>
            </thead>
            <tbody>
              {state.data.rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td className={numCell}>{r.calls.toLocaleString('ru-RU')}</td>
                  <td className={numCell}>
                    {r.inputTokens.toLocaleString('ru-RU')} / {r.outputTokens.toLocaleString('ru-RU')}
                  </td>
                  <td className={numCell}>{rub(r.costRub)}</td>
                  <td>{r.lastCallAt ? dateTime(r.lastCallAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ) : null}
    </Card>
  );
}
