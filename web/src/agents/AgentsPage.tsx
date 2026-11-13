// «Агенты» (spec, section 7): the agents of the person's departments as cards.
import { Link } from 'react-router';
import { ru } from '../i18n/ru.ts';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { fetchAgents } from './api.ts';

export function AgentsPage() {
  const { state, reload } = useLoad(fetchAgents);
  return (
    <section>
      <h1>{ru.agents.title}</h1>
      {state.status === 'loading' ? <Skeleton rows={3} /> : null}
      {state.status === 'error' ? <ErrorBanner title={ru.agents.loadFailed} error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' && state.data.agents.length === 0 ? <p className="empty">{ru.agents.empty}</p> : null}
      {state.status === 'ready' && state.data.agents.length > 0 ? (
        <ul className="cards">
          {state.data.agents.map((agent) => (
            <li key={agent.id} className="card">
              <Link to={`/agents/${encodeURIComponent(agent.id)}`}>
                <span className="card-title">{agent.name}</span>
                <span className="card-text">{agent.description}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
