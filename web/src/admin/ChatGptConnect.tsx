// Connecting a ChatGPT account (spec, scenario 9, section 8.1): the server asks OpenAI for a code,
// the person enters it on OpenAI's page and logs in there; this window asks the server every
// `intervalSeconds` whether the login is done. «Войти заново» is the same with the account named.
// Closing while it waits asks first: the person may have entered the code on OpenAI's page already.
import type { ChatGptAccountDto, ChatGptLoginDto } from '@bba/contracts';
import { useEffect, useRef, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { Button } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Modal } from '../ui/Modal.tsx';
import { adminApi } from './api.ts';
import styles from './models.module.css';
import section from './section.module.css';

// A little after the interval: the server answers OpenAI's interval exactly, not sooner.
const POLL_MARGIN_MS = 300;
// Only a broken connection leaves the login going on the server: the same code is asked about
// again. After any other answer the server has ended the login, and a new code is needed.
const RESUMABLE_CODES = new Set(['APP_NETWORK_FAILED', 'APP_SERVER_UNAVAILABLE']);

// `deadline` — this computer's time the code runs out, counted from the server's answer.
interface Code {
  login: ChatGptLoginDto;
  deadline: number;
}

type Phase = { kind: 'starting' } | ({ kind: 'waiting' } & Code) | { kind: 'failed'; error: ApiRequestError; code: Code | null };

function left(deadline: number, now: number): string {
  const seconds = Math.max(0, Math.round((deadline - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function Waiting({ login, deadline }: Code) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // The browser gives the clipboard only over https; over http the code is selected to copy by hand.
  const clipboard = window.isSecureContext && 'clipboard' in navigator;
  const copy = () =>
    navigator.clipboard.writeText(login.userCode).then(
      () => setCopied(true),
      (error: unknown) => console.warn('clipboard is not available', error),
    );
  return (
    <>
      <p className={section.note}>Откройте сайт OpenAI и введите код:</p>
      <div className={styles.code}>
        <input className={styles.codeText} readOnly value={login.userCode} aria-label="Код входа" onFocus={(e) => e.currentTarget.select()} />
        {clipboard ? (
          <Button icon="copy" size="sm" onClick={() => void copy()}>
            {copied ? 'Скопировано' : 'Скопировать'}
          </Button>
        ) : null}
      </div>
      <a className={styles.openSite} href={login.verifyUrl} target="_blank" rel="noreferrer">
        Открыть сайт OpenAI
      </a>
      {/* Said once by a screen reader; the countdown is read on request, not every second. */}
      <p className={styles.waiting}>
        <span className={styles.spin} aria-hidden="true" />
        <span role="status">Жду входа…</span>
        <span role="timer">осталось {left(deadline, now)}</span>
      </p>
      <p className={section.sub}>Войти может владелец аккаунта на своём устройстве — передайте ему код. Код действует 15 минут; посторонним его не сообщайте.</p>
    </>
  );
}

export function ChatGptConnect({
  account,
  onClose,
  onConnected,
  onEnded,
}: {
  account: ChatGptAccountDto | null;
  onClose: () => void;
  onConnected: (account: ChatGptAccountDto) => void;
  // The login ended without an answer here (e.g. the connection broke as it finished): the list is
  // asked again, in case the account got connected.
  onEnded: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const confirm = useConfirm();
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
      (login) => !gone && setPhase({ kind: 'waiting', login, deadline: Date.now() + login.expiresInSeconds * 1000 }),
      (raw: unknown) => !gone && setPhase({ kind: 'failed', error: asApiError(raw), code: null }),
    );
    return () => {
      gone = true;
    };
  }, [account?.id, attempt]);

  const waiting: Code | null = phase.kind === 'waiting' ? phase : null;
  const login = waiting?.login ?? null;
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
        if (!gone) setPhase((p) => ({ kind: 'failed', error: asApiError(raw), code: p.kind === 'waiting' ? { login: p.login, deadline: p.deadline } : null }));
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
  const resume = failed?.code && RESUMABLE_CODES.has(failed.error.code) ? failed.code : null;
  const ended = failed !== null && failed.code !== null && !resume;
  const endedRef = useRef(onEnded);
  useEffect(() => {
    endedRef.current = onEnded;
  });
  useEffect(() => {
    if (ended) endedRef.current();
  }, [ended]);

  async function close() {
    if (
      phase.kind === 'waiting' &&
      !(await confirm({ title: 'Прервать вход?', text: 'Если владелец аккаунта уже ввёл код, аккаунт не подключится — понадобится новый код.', confirmLabel: 'Прервать', danger: true }))
    ) {
      return;
    }
    onClose();
  }

  return (
    <Modal open onClose={() => void close()} label={title}>
      <div className={section.form}>
        <h2 className={section.formTitle}>{title}</h2>
        {phase.kind === 'starting' ? (
          <p className={styles.waiting} role="status">
            <span className={styles.spin} aria-hidden="true" />
            Получаю код у OpenAI…
          </p>
        ) : null}
        {waiting ? <Waiting login={waiting.login} deadline={waiting.deadline} /> : null}
        {failed ? <ErrorBanner error={failed.error} {...(resume ? { onRetry: () => setPhase({ kind: 'waiting', ...resume }) } : {})} /> : null}
        <div className={section.formActions}>
          <Button onClick={() => void close()}>{failed ? 'Закрыть' : 'Отмена'}</Button>
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
