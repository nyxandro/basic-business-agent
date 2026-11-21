// «Подключения» (spec, scenario 3; mockup): the systems of the installation — how they are
// connected, their state and how many employees have connected them. Each employee connects a
// system themselves, and the agent works there with their rights.
import type { AdminConnection, McpServerView } from '@bba/contracts';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { Card, PageHead, Pill, Progress } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { MailCard } from './MailCard.tsx';
import { McpServerCard } from './McpServerCard.tsx';
import { McpServerDialog } from './McpServerDialog.tsx';
import section from './section.module.css';
import styles from './systems.module.css';

const HOW: Record<AdminConnection['auth'], string> = { oauth: 'вход через сайт системы', static: 'личный ключ сотрудника', identity: 'по учётной записи' };
const DESC: Record<AdminConnection['mode'], string> = {
  personal: 'Агент видит в системе ровно то, что видит сотрудник.',
  shared: 'Общее подключение для всех; система сама применяет права сотрудника.',
};

const monogram = (title: string) =>
  title
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 3)
    .toUpperCase();

function state(c: AdminConnection): { text: string; tone: 'ok' | 'bad' | 'neutral' } {
  const errors = c.employees.auth_error ?? 0;
  if (errors > 0) return { text: `Ошибка доступа: ${errors}`, tone: 'bad' };
  if (c.mode === 'shared' || (c.employees.connected ?? 0) > 0) return { text: 'Работает', tone: 'ok' };
  return { text: 'Не подключено', tone: 'neutral' };
}

function SystemCard({ c }: { c: AdminConnection }) {
  const shown = state(c);
  // Out of the employees whose agents use the system, not of everybody.
  const total = c.possible;
  const connected = c.employees.connected ?? 0;
  const unverified = c.employees.unverified ?? 0;
  return (
    <Card className={`${styles.card} rise`}>
      <div className={styles.head}>
        <span className={styles.mono} aria-hidden="true">
          {monogram(c.title)}
        </span>
        <div className={styles.title}>
          <div className={styles.name}>{c.title}</div>
          <div className={section.sub}>{c.mode === 'shared' ? 'общее подключение' : HOW[c.auth]}</div>
        </div>
        <Pill tone={shown.tone}>{shown.text}</Pill>
      </div>
      <p className={styles.desc}>{DESC[c.mode]}</p>
      <div>
        <div className={styles.countRow}>
          <span className={section.sub}>Подключили сотрудники</span>
          <span className={styles.count}>{c.mode === 'shared' ? 'для всех' : `${connected} из ${total}`}</span>
        </div>
        <Progress value={c.mode === 'shared' ? 1 : total > 0 ? connected / total : 0} label={`${c.title}: подключили сотрудники`} height={5} />
        {unverified > 0 ? <div className={section.sub}>Сохранили ключ, но система его ещё не проверила: {unverified}</div> : null}
      </div>
    </Card>
  );
}

interface Opened {
  server: McpServerView | null;
  autoCheck: boolean;
  error: ApiRequestError | null;
}

// Back from the system's site after the admin's sign-in: ?mcp=<id>&signedIn=1, or ?mcp=<id>&error=<code>.
function useReturnFromSignIn(open: (opened: Opened) => void) {
  const [params, setParams] = useSearchParams();
  const id = params.get('mcp');
  const signedIn = params.get('signedIn') === '1';
  const code = params.get('error');
  useEffect(() => {
    if (!id) return;
    setParams({}, { replace: true });
    void adminApi.mcpServer(id).then(
      ({ server }) => open({ server, autoCheck: signedIn, error: code ? new ApiRequestError({ code, message: ru.connections.connectFailed(server.title), status: 0 }) : null }),
      // The server is gone (deleted meanwhile): nothing to open.
      (error: unknown) => console.warn('mcp server of the sign-in is not available', error),
    );
  }, [id, signedIn, code, setParams, open]);
}

export function ConnectionsSection() {
  const { state: load, reload } = useLoad(adminApi.connections, ['admin', 'connections']);
  const { state: servers, reload: reloadServers } = useLoad(adminApi.mcpServers, ['admin', 'mcp-servers']);
  const [opened, setOpened] = useState<Opened | null>(null);
  useReturnFromSignIn(setOpened);
  return (
    <div className={section.stack}>
      <PageHead
        title="Подключения"
        lead="Каждый сотрудник подключает системы сам, и агент работает там с его правами."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setOpened({ server: null, autoCheck: false, error: null })}>
            {ru.mcp.admin.add}
          </Button>
        }
      />
      {load.status === 'loading' || servers.status === 'loading' ? <DelayedBar /> : null}
      {load.status === 'error' ? <ErrorBanner error={load.error} onRetry={reload} /> : null}
      {servers.status === 'error' ? <ErrorBanner error={servers.error} onRetry={reloadServers} /> : null}
      {/* The mail is in every installation (spec, section 8.24); then MCP servers of the admin, then plugins. */}
      <div className={styles.grid}>
        <MailCard />
        {servers.status === 'ready'
          ? servers.data.servers.map((s) => <McpServerCard key={s.id} server={s} onOpen={() => setOpened({ server: s, autoCheck: false, error: null })} onRemoved={reloadServers} />)
          : null}
        {load.status === 'ready' ? load.data.connections.map((c) => <SystemCard key={c.id} c={c} />) : null}
      </div>
      {opened ? <McpServerDialog server={opened.server} autoCheck={opened.autoCheck} initialError={opened.error} onClose={() => setOpened(null)} onChanged={reloadServers} /> : null}
    </div>
  );
}
