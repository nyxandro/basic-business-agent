// Notifications of this browser — the block under the list of the bell and the card of «Настройки → Уведомления»
// (docs/specs/[20.11.2026]-notifications.md, scenario 1 and section 7): what the browser can, «Включить», «Проверить».
import { useCallback, useEffect, useState } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { notificationTexts as t } from '../i18n/notifications.ts';
import { Button } from '../ui/Button.tsx';
import { ErrorBanner, Notice } from '../ui/ErrorBanner.tsx';
import { useToast } from '../ui/Toast.tsx';
import { sendTestPush } from './api.ts';
import { currentState, disablePush, enablePush, PushNotAllowed, type PushState } from './push.ts';
import styles from './notifications.module.css';

const STATE_TEXT: Record<Exclude<PushState, 'checking'>, string> = {
  on: t.stateOn,
  off: t.stateOff,
  unsupported: t.stateUnsupported,
  insecure: t.stateInsecure,
  'ios-home-screen': t.stateIos,
  denied: t.stateDenied,
};

export function usePushState() {
  const [state, setState] = useState<PushState>('checking');
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let current = true;
    currentState().then(
      (next) => current && setState(next),
      (raw: unknown) => {
        if (!current) return;
        setError(asApiError(raw));
        setState('off');
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setRefused(false);
    try {
      await work();
    } catch (raw) {
      if (raw instanceof PushNotAllowed) setRefused(true);
      else setError(asApiError(raw));
    } finally {
      setBusy(false);
    }
  }, []);

  const enable = () =>
    run(async () => {
      const next = await enablePush();
      setState(next);
      if (next === 'on') {
        toast(t.enabled);
        // The trial push proves the whole way at once (scenario 1).
        await sendTestPush();
      }
    });
  const disable = () =>
    run(async () => {
      await disablePush();
      setState('off');
      toast(t.disabledDone);
    });
  const test = () =>
    run(async () => {
      await sendTestPush();
      toast(t.testSent);
    });
  return { state, error, refused, busy, enable, disable, test };
}

// Under the list of the bell: shown only while notifications of this browser are not on.
export function PushPrompt() {
  const push = usePushState();
  if (push.state === 'on' || push.state === 'checking') return null;
  const canEnable = push.state === 'off';
  return (
    <div className={styles.prompt}>
      <p className={styles.promptText}>{canEnable ? t.enablePrompt : STATE_TEXT[push.state]}</p>
      {push.refused ? <p className={styles.promptText}>{t.stateNotAllowed}</p> : null}
      {canEnable ? (
        <Button variant="primary" disabled={push.busy} onClick={() => void push.enable()}>
          {t.enable}
        </Button>
      ) : null}
      {push.error ? <ErrorBanner error={push.error} /> : null}
    </div>
  );
}

// «Настройки → Уведомления»: the state of this browser and what can be done with it.
export function PushSettings() {
  const push = usePushState();
  return (
    <div className={styles.settings}>
      <p className={styles.state} aria-live="polite">
        {push.state === 'checking' ? t.checking : STATE_TEXT[push.state]}
      </p>
      {push.refused ? <Notice>{t.stateNotAllowed}</Notice> : null}
      <div className={styles.actions}>
        {push.state === 'off' ? (
          <Button variant="primary" disabled={push.busy} onClick={() => void push.enable()}>
            {t.enable}
          </Button>
        ) : null}
        {push.state === 'on' ? (
          <>
            <Button variant="primary" disabled={push.busy} onClick={() => void push.test()}>
              {t.test}
            </Button>
            <Button variant="secondary" disabled={push.busy} onClick={() => void push.disable()}>
              {t.disable}
            </Button>
          </>
        ) : null}
      </div>
      {push.error ? <ErrorBanner error={push.error} /> : null}
    </div>
  );
}
