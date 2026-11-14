// Connecting a ChatGPT account (spec, scenario 9, section 8.1): the server asks OpenAI for a code,
// the person enters it on OpenAI's page and logs in there; this window asks the server every
// `intervalSeconds` whether the login is done. «Войти заново» is the same with the account named.
import type { ChatGptAccountDto, ChatGptLoginDto } from '@bba/contracts';
import { useEffect, useRef, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { Button } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Modal } from '../ui/Modal.tsx';
import { adminApi } from './api.ts';
import styles from './models.module.css';
import section from './section.module.css';

// A little after the interval: the server answers OpenAI's interval exactly, not sooner.
const POLL_MARGIN_MS = 300;
// The login is over with these: a new code is needed. Others (the network) — ask again.
const FINAL_CODES = new Set(['APP_CHATGPT_LOGIN_EXPIRED', 'APP_CHATGPT_LOGIN_FAILED', 'APP_NOT_FOUND', 'APP_VALIDATION_FAILED']);

type Phase = { kind: 'starting' } | { kind: 'waiting'; login: ChatGptLoginDto } | { kind: 'failed'; error: ApiRequestError; login: ChatGptLoginDto | null };

function left(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function Waiting({ login }: { login: ChatGptLoginDto }) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const copy = () =>
    navigator.clipboard.writeText(login.userCode).then(
      () => setCopied(true),
      // Without clipboard access the code stays on the screen to type.
      (error: unknown) => console.warn('clipboard is not available', error),
    );
  return (
    <>
      <p className={section.note}>Откройте сайт OpenAI и введите код:</p>
      <div className={styles.code}>
        <span className={styles.codeText} aria-label="Код входа">
          {login.userCode}
        </span>
        <Button icon="copy" size="sm" onClick={() => void copy()}>
          {copied ? 'Скопировано' : 'Скопировать'}
        </Button>
      </div>
      <a className={styles.openSite} href={login.verifyUrl} target="_blank" rel="noreferrer">
        Открыть сайт OpenAI
      </a>
      <p className={styles.waiting} role="status">
        <span className={styles.spin} aria-hidden="true" />
        Жду входа… осталось {left(login.expiresAt, now)}
      </p>
      <p className={section.sub}>Войти может владелец аккаунта на своём устройстве — передайте ему код. Код действует 15 минут; посторонним его не сообщайте.</p>
    </>
  );
}

export function ChatGptConnect({ account, onClose, onConnected }: { account: ChatGptAccountDto | null; onClose: () => void; onConnected: (account: ChatGptAccountDto) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [attempt, setAttempt] = useState(0);
  // The page may draw again while the person logs in; the asking goes on with the latest callback.
  const connected = useRef(onConnected);
  useEffect(() => {
    connected.current = onConnected;
  });
  const title = account ? `Войти заново: ${account.email}` : 'Подключить аккаунт ChatGPT';

  useEffect(() => {
    let gone = false;
    adminApi.startChatGptLogin(account?.id ?? null).then(
      (login) => !gone && setPhase({ kind: 'waiting', login }),
      (raw: unknown) => !gone && setPhase({ kind: 'failed', error: asApiError(raw), login: null }),
    );
    return () => {
      gone = true;
    };
  }, [account?.id, attempt]);

  const login = phase.kind === 'waiting' ? phase.login : null;
  useEffect(() => {
    if (!login) return;
    let gone = false;
    let timer: ReturnType<typeof setTimeout>;
    const ask = async () => {
      try {
        const status = await adminApi.pollChatGptLogin(login.id);
        if (gone) return;
        if (status.status === 'connected') connected.current(status.account);
        else timer = setTimeout(() => void ask(), login.intervalSeconds * 1000 + POLL_MARGIN_MS);
      } catch (raw) {
        if (!gone) setPhase({ kind: 'failed', error: asApiError(raw), login });
      }
    };
    timer = setTimeout(() => void ask(), login.intervalSeconds * 1000 + POLL_MARGIN_MS);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [login]);

  const restart = () => {
    setPhase({ kind: 'starting' });
    setAttempt((n) => n + 1);
  };
  const failed = phase.kind === 'failed' ? phase : null;
  // A broken connection does not end the login: the same code is asked about again.
  const resume = failed?.login && !FINAL_CODES.has(failed.error.code) ? failed.login : null;

  return (
    <Modal open onClose={onClose} label={title}>
      <div className={section.form}>
        <h2 className={section.formTitle}>{title}</h2>
        {phase.kind === 'starting' ? (
          <p className={styles.waiting} role="status">
            <span className={styles.spin} aria-hidden="true" />
            Получаю код у OpenAI…
          </p>
        ) : null}
        {login ? <Waiting login={login} /> : null}
        {failed ? <ErrorBanner error={failed.error} {...(resume ? { onRetry: () => setPhase({ kind: 'waiting', login: resume }) } : {})} /> : null}
        <div className={section.formActions}>
          <Button onClick={onClose}>{failed ? 'Закрыть' : 'Отмена'}</Button>
          {failed && !resume ? (
            <Button variant="primary" onClick={restart}>
              Начать заново
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
