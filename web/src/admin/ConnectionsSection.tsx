// «Подключения» (spec, scenario 3; mockup): the systems of the installation — how they are
// connected, their state and how many employees have connected them. Each employee connects a
// system themselves, and the agent works there with their rights.
import type { AdminConnection } from '@bba/contracts';
import { Card, EmptyState, PageHead, Pill, Progress } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
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

function SystemCard({ c, total }: { c: AdminConnection; total: number }) {
  const shown = state(c);
  const connected = c.employees.connected ?? 0;
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
      </div>
    </Card>
  );
}

export function ConnectionsSection() {
  const { state: load, reload } = useLoad(adminApi.connections);
  return (
    <div className={section.stack}>
      <PageHead title="Подключения" lead="Каждый сотрудник подключает системы сам, и агент работает там с его правами." />
      {load.status === 'loading' ? <Skeleton rows={3} /> : null}
      {load.status === 'error' ? <ErrorBanner error={load.error} onRetry={reload} /> : null}
      {load.status === 'ready' && load.data.connections.length === 0 ? (
        <Card>
          <EmptyState title="Подключаемых систем в этой установке нет" text="Их добавляет разработчик плагинами." />
        </Card>
      ) : null}
      {load.status === 'ready' && load.data.connections.length > 0 ? (
        <div className={styles.grid}>
          {load.data.connections.map((c) => (
            <SystemCard key={c.id} c={c} total={load.data.employeesTotal} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
