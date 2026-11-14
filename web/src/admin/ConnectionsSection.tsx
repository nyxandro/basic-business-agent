// «Подключения» (spec, scenario 3): connected systems and how many employees have connected them.
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';

const MODE = { personal: 'личный доступ каждого сотрудника', shared: 'общий доступ установки' } as const;
const AUTH = { oauth: 'вход через систему', static: 'личный ключ', identity: 'по учётной записи' } as const;

export function ConnectionsSection() {
  const { state, reload } = useLoad(adminApi.connections);
  if (state.status === 'loading') return <Skeleton rows={2} />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const list = state.data.connections;
  return (
    <div>
      <h1>Подключения</h1>
      {list.length === 0 ? <p className="empty">Подключаемых систем в этой установке нет. Их добавляет разработчик плагинами.</p> : null}
      {list.length > 0 ? (
        <div className="table-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Система</th>
                <th scope="col">Доступ</th>
                <th scope="col">Подключено</th>
                <th scope="col">Не проверено</th>
                <th scope="col">Ошибка доступа</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td>{c.title}</td>
                  <td>
                    {MODE[c.mode]}, {AUTH[c.auth]}
                  </td>
                  <td>{c.employees.connected ?? 0}</td>
                  <td>{c.employees.unverified ?? 0}</td>
                  <td>{c.employees.auth_error ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
