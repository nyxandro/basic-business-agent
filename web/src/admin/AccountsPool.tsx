// «Пул аккаунтов подписки» of «Нейросеть» (spec, scenario 9, section 8.1; mockup): every ChatGPT
// account with its state — «Работает», «Охлаждение — ошибка 429, вернётся в 14:32», «Ошибка
// доступа — войдите заново», «Нет запросов» — today's tokens, «Войти заново» and «Отключить».
import type { ChatGptAccountDto } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { Button, cx, IconButton } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, EmptyState, Progress } from '../ui/Display.tsx';
import { plural, thousands, whenLabel } from '../ui/format.ts';
import { Menu, MenuAnchor, MenuItem, MenuSeparator } from '../ui/Menu.tsx';
import { useToast } from '../ui/Toast.tsx';
import { adminApi } from './api.ts';
import { ChatGptConnect } from './ChatGptConnect.tsx';
import styles from './models.module.css';
import { Feedback, useAction } from './parts.tsx';
import section from './section.module.css';

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function accountStateText(a: ChatGptAccountDto): string {
  switch (a.state) {
    case 'works':
      return a.lastSuccessAt ? `Работает · последний успешный запрос ${whenLabel(a.lastSuccessAt)}` : 'Работает';
    case 'cooldown':
      return `Охлаждение — ошибка ${a.failureStatus ?? '?'}, вернётся в ${hhmm(a.cooldownUntil!)}`;
    case 'auth_error':
      return 'Ошибка доступа — войдите заново';
    case 'no_requests':
      return 'Нет запросов';
  }
}

const tokensText = (n: number) => `${thousands(n)} ${plural(n >= 1000 ? 5 : n, ['токен', 'токена', 'токенов'])} сегодня`;

function AccountMenu({ account, onRelogin, onChanged }: { account: ChatGptAccountDto; onRelogin: () => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const confirm = useConfirm();
  const { error, run } = useAction();
  const label = `Действия: ${account.email}`;
  return (
    <MenuAnchor>
      <IconButton icon="dots" label={label} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} />
      <Menu open={open} onClose={() => setOpen(false)} label={label} width={220}>
        <MenuItem icon="redo" onSelect={() => (setOpen(false), onRelogin())}>
          Войти заново
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon="trash"
          danger
          onSelect={() => {
            setOpen(false);
            void confirm({
              title: `Отключить ${account.email}?`,
              text: 'Запросы подписки пойдут через остальные аккаунты. Данные входа удалятся, подключить аккаунт можно снова.',
              confirmLabel: 'Отключить',
              danger: true,
            }).then(async (yes) => {
              if (yes && (await run(() => adminApi.disconnectChatGptAccount(account.id), 'Аккаунт отключён'))) onChanged();
            });
          }}
        >
          Отключить
        </MenuItem>
      </Menu>
      <Feedback error={error} />
    </MenuAnchor>
  );
}

export function AccountsPool({ accounts, onChanged }: { accounts: ChatGptAccountDto[]; onChanged: () => void }) {
  // undefined — closed; null — a new account; an account — «Войти заново».
  const [connecting, setConnecting] = useState<ChatGptAccountDto | null | undefined>(undefined);
  const toast = useToast();
  const most = Math.max(0, ...accounts.map((a) => a.tokensToday));
  const connected = useCallback(
    (account: ChatGptAccountDto) => {
      setConnecting(undefined);
      toast(`Аккаунт подключён: ${account.email}`);
      onChanged();
    },
    [toast, onChanged],
  );
  return (
    <Card className={`${styles.poolCard} rise`}>
      <div className={styles.poolHead}>
        <div className={styles.poolTitle}>
          <h2 className={styles.cardTitle}>Пул аккаунтов подписки</h2>
          <div className={section.sub}>Раздача по кругу, упавший пропускается</div>
        </div>
        <IconButton icon="plus" variant="outline" label="Добавить аккаунт" onClick={() => setConnecting(null)} />
      </div>
      {accounts.length === 0 ? (
        <EmptyState
          title="Аккаунтов пока нет"
          text="Подключите аккаунт ChatGPT — модели подписки будут отвечать через него. Несколько аккаунтов делят запросы между собой."
          action={<Button onClick={() => setConnecting(null)}>Подключить аккаунт ChatGPT</Button>}
        />
      ) : (
        <ul className={styles.pool} aria-label="Аккаунты подписки">
          {accounts.map((a) => (
            <li key={a.id} className={styles.account}>
              <span className={cx(styles.dot, styles[`state_${a.state}`], a.state === 'cooldown' && styles.pulse)} aria-hidden="true" />
              <div className={styles.accountMain}>
                <div className={styles.accountName}>{a.email}</div>
                <div className={cx(section.sub, a.state === 'auth_error' && styles.bad)}>{accountStateText(a)}</div>
              </div>
              {a.state === 'auth_error' ? (
                <Button size="sm" onClick={() => setConnecting(a)}>
                  Войти заново
                </Button>
              ) : (
                <div className={styles.usage}>
                  <Progress value={most > 0 ? a.tokensToday / most : 0} label={`Токены за сегодня: ${a.email}`} />
                  <div className={styles.usageText}>{tokensText(a.tokensToday)}</div>
                </div>
              )}
              <AccountMenu account={a} onRelogin={() => setConnecting(a)} onChanged={onChanged} />
            </li>
          ))}
        </ul>
      )}
      {connecting !== undefined ? <ChatGptConnect account={connecting} onClose={() => setConnecting(undefined)} onConnected={connected} /> : null}
    </Card>
  );
}
