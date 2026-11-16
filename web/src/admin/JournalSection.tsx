// «Журнал действий» (spec, section 8.4; mockup): what agents did in external systems, in the chat or
// in the background, and who answered «Да». Records are never deleted.
import type { JournalEntry } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { Button } from '../ui/Button.tsx';
import { Card, EmptyState, PageHead, Pill, type Tone } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { dateTime } from '../ui/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { Table } from '../ui/Table.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { monthStart, today } from './dates.ts';
import styles from './journal.module.css';
import section from './section.module.css';

const EVENTS: Record<string, string> = {
  tool_call: 'Действие',
  tool_declined: 'Отказ',
  approval_expired: 'Вопрос истёк',
  background_started: 'Запуск задачи',
  background_finished: 'Задача завершена',
  background_skipped: 'Запуск пропущен',
};
const RESULTS: Record<string, { text: string; tone: Tone }> = {
  ok: { text: 'Выполнено', tone: 'ok' },
  error: { text: 'Ошибка', tone: 'bad' },
  declined: { text: 'Отклонено', tone: 'neutral' },
  expired: { text: 'Истекло', tone: 'warn' },
  skipped: { text: 'Пропущено', tone: 'warn' },
  started: { text: 'Начато', tone: 'accent' },
};
const MAX_ARGS = 160;

function argsText(args: unknown): string {
  if (args === null || args === undefined) return '';
  const text = JSON.stringify(args);
  return text.length > MAX_ARGS ? `${text.slice(0, MAX_ARGS)}…` : text;
}

function Row({ e }: { e: JournalEntry }) {
  const result = RESULTS[e.result] ?? { text: e.result, tone: 'neutral' as Tone };
  return (
    <tr>
      <td className={styles.when}>{dateTime(e.at)}</td>
      <td>{e.user ?? '—'}</td>
      <td>{e.agent ?? '—'}</td>
      <td>
        <Pill>{e.runKind === 'background' ? 'фон' : 'чат'}</Pill>
      </td>
      <td>
        <div>
          {EVENTS[e.event] ?? e.event}
          {e.tool ? <span className={styles.tool}> {e.tool}</span> : null}
        </div>
        {e.args ? <div className={styles.args}>{argsText(e.args)}</div> : null}
      </td>
      <td>
        <Pill tone={result.tone}>{result.text}</Pill>
        {e.errorCode ? <div className={styles.code}>{e.errorCode}</div> : null}
        {e.approvedBy ? <div className={section.sub}>«Да» — {e.approvedBy}</div> : null}
      </td>
    </tr>
  );
}

export function JournalSection() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [page, setPage] = useState(1);
  const load = useCallback(() => adminApi.journal({ from, to, page }), [from, to, page]);
  const { state, reload } = useLoad(load, ['admin', 'journal', from, to, page]);
  return (
    <div className={section.stack}>
      <PageHead title="Журнал действий" lead="Что агенты сделали во внешних системах и кто подтвердил. Записи не удаляются." />
      <div className={`${styles.filters} rise`}>
        <Field label="С">
          <Input
            type="date"
            value={from}
            max={to}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </Field>
        <Field label="По">
          <Input
            type="date"
            value={to}
            min={from}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </Field>
      </div>
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' && state.data.entries.length === 0 ? (
        <Card>
          <EmptyState title="За этот период записей нет" />
        </Card>
      ) : null}
      {state.status === 'ready' && state.data.entries.length > 0 ? (
        <>
          <Card className={`${section.tableCard} rise`}>
            <Table minWidth={860} label="Журнал действий">
              <thead>
                <tr>
                  <th scope="col">Когда</th>
                  <th scope="col">Сотрудник</th>
                  <th scope="col">Агент</th>
                  <th scope="col">Режим</th>
                  <th scope="col">Действие</th>
                  <th scope="col">Результат</th>
                </tr>
              </thead>
              <tbody>
                {state.data.entries.map((e) => (
                  <Row key={e.id} e={e} />
                ))}
              </tbody>
            </Table>
          </Card>
          <div className={styles.pages}>
            <Button disabled={page === 1} onClick={() => setPage(page - 1)}>
              Назад
            </Button>
            <span className={section.sub}>Страница {page}</span>
            <Button disabled={state.data.entries.length < state.data.pageSize} onClick={() => setPage(page + 1)}>
              Дальше
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
