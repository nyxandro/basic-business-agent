// «Журнал действий» (spec, section 8.4): what agents did in external systems, who answered «Да».
import type { JournalEntry } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dateTime } from '../ui/format.ts';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { monthStart, today } from './dates.ts';

const EVENTS: Record<string, string> = {
  tool_call: 'действие',
  tool_declined: 'отказ',
  approval_expired: 'вопрос истёк',
  background_started: 'запуск задачи',
  background_finished: 'задача завершена',
  background_skipped: 'запуск пропущен',
};
const RESULTS: Record<string, string> = { ok: 'выполнено', error: 'ошибка', declined: 'отменено', expired: 'истекло', skipped: 'пропущено', started: 'начато' };

const argsText = (args: unknown) => (args === null || args === undefined ? '' : JSON.stringify(args));

function Row({ e }: { e: JournalEntry }) {
  return (
    <tr>
      <td>{dateTime(e.at)}</td>
      <td>{e.user ?? '—'}</td>
      <td>{e.agent ?? '—'}</td>
      <td>
        {EVENTS[e.event] ?? e.event}
        {e.runKind === 'background' ? ' (фоновая)' : ''}
      </td>
      <td>
        {e.tool ?? ''}
        {e.args ? <div className="muted journal-args">{argsText(e.args)}</div> : null}
      </td>
      <td>{e.approvedBy ? 'подтвердил сотрудник' : '—'}</td>
      <td>
        {RESULTS[e.result] ?? e.result}
        {e.errorCode ? <span className="banner-code"> {e.errorCode}</span> : null}
      </td>
    </tr>
  );
}

export function JournalSection() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [page, setPage] = useState(1);
  const load = useCallback(() => adminApi.journal({ from, to, page }), [from, to, page]);
  const { state, reload } = useLoad(load);
  return (
    <div>
      <h1>Журнал действий</h1>
      <div className="filters">
        <label>
          С
          <input type="date" value={from} max={to} onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }} />
        </label>
        <label>
          По
          <input type="date" value={to} min={from} onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }} />
        </label>
      </div>
      {state.status === 'loading' ? <Skeleton rows={4} /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' && state.data.entries.length === 0 ? <p className="empty">За этот период записей нет.</p> : null}
      {state.status === 'ready' && state.data.entries.length > 0 ? (
        <>
          <div className="table-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Когда</th>
                  <th scope="col">Сотрудник</th>
                  <th scope="col">Агент</th>
                  <th scope="col">Событие</th>
                  <th scope="col">Действие</th>
                  <th scope="col">«Да»</th>
                  <th scope="col">Итог</th>
                </tr>
              </thead>
              <tbody>
                {state.data.entries.map((e) => (
                  <Row key={e.id} e={e} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="row-buttons">
            <button type="button" className="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
              Назад
            </button>
            <span className="muted">Страница {page}</span>
            <button type="button" className="secondary" disabled={state.data.entries.length < state.data.pageSize} onClick={() => setPage(page + 1)}>
              Дальше
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
