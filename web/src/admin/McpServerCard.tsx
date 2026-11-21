// The card of an MCP server in «Подключения» (docs/specs/[20.11.2026]-mcp-connections.md, sections 7 and 20): the way
// of sign-in, the state — «Черновик», «Работает», «Общий ключ не принят», «Ошибка доступа: N», «Новых действий: N» —
// and how many of the employees who could use it do; «Изменить» opens the window, «Удалить» asks first.
import type { McpServerView } from '@bba/contracts';
import { ru } from '../i18n/ru.ts';
import { Button, cx } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, Pill, Progress } from '../ui/Display.tsx';
import { adminApi } from './api.ts';
import { Feedback, useAction } from './parts.tsx';
import section from './section.module.css';
import styles from './systems.module.css';
import mcp from './mcp.module.css';

const t = ru.mcp.admin;

const monogram = (title: string) =>
  title
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 3)
    .toUpperCase();

export function McpServerCard({ server, onOpen, onRemoved }: { server: McpServerView; onOpen: () => void; onRemoved: () => void }) {
  const confirm = useConfirm();
  const { busy, error, run } = useAction();
  const fresh = server.actions.filter((a) => a.isNew).length;
  const personal = server.auth === 'personal_key' || server.auth === 'oauth';
  const { using, connected, authErrors, possible } = server.usage;
  const count = personal ? connected : using;
  const tone = server.status === 'enabled' ? 'ok' : server.status === 'draft' || server.status === 'disabled' ? 'neutral' : 'bad';

  async function remove() {
    const ok = await confirm({ title: t.removeTitle(server.title), text: t.removeText(personal ? connected + authErrors : using), confirmLabel: t.remove, danger: true });
    if (ok) await run(async () => {
      await adminApi.deleteMcp(server.id);
      onRemoved();
    });
  }

  return (
    <Card className={cx(styles.card, 'rise')}>
      <div className={styles.head}>
        <span className={styles.mono} aria-hidden="true">
          {monogram(server.title)}
        </span>
        <div className={styles.title}>
          <div className={styles.name}>{server.title}</div>
          <div className={section.sub}>{t.authShort[server.auth]}</div>
        </div>
        <Pill tone={tone}>{t.states[server.status]}</Pill>
      </div>
      {authErrors > 0 || fresh > 0 ? (
        <div className={mcp.badges}>
          {authErrors > 0 ? <Pill tone="bad">{t.authErrors(authErrors)}</Pill> : null}
          {fresh > 0 ? <Pill tone="accent">{t.newActions(fresh)}</Pill> : null}
        </div>
      ) : null}
      {server.status === 'draft' ? (
        <p className={styles.desc}>{t.draftLead}</p>
      ) : (
        <div>
          <div className={styles.countRow}>
            <span className={section.sub}>{t.usage}</span>
            <span className={styles.count}>{t.usageOf(count, possible)}</span>
          </div>
          <Progress value={possible > 0 ? count / possible : 0} label={`${server.title}: ${t.usage.toLowerCase()}`} height={5} />
        </div>
      )}
      <Feedback error={error} />
      <div className={mcp.cardActions}>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
          {t.remove}
        </Button>
        <Button size="sm" disabled={busy} onClick={onOpen}>
          {t.edit}
        </Button>
      </div>
    </Card>
  );
}
