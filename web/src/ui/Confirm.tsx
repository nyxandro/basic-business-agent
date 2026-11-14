// «Удалить …?» (spec, section 12): a question in a dialog of the interface instead of the
// browser's own window. useConfirm() returns a function that opens it and resolves with the answer.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Button } from './Button.tsx';
import styles from './confirm.module.css';
import { Modal } from './Modal.tsx';

export interface ConfirmRequest {
  title: string;
  text?: string;
  confirmLabel: string;
  danger?: boolean;
}

type Ask = (request: ConfirmRequest) => Promise<boolean>;

const ConfirmContext = createContext<Ask | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<(ConfirmRequest & { answer: (yes: boolean) => void }) | null>(null);
  const ask = useCallback<Ask>((request) => new Promise((resolve) => setPending({ ...request, answer: resolve })), []);
  const close = (yes: boolean) => {
    pending?.answer(yes);
    setPending(null);
  };
  const value = useMemo(() => ask, [ask]);
  return (
    <ConfirmContext value={value}>
      {children}
      <Modal open={pending !== null} onClose={() => close(false)} label={pending?.title ?? ''} narrow role="alertdialog">
        {pending ? (
          <div className={styles.box}>
            <h2 className={styles.title}>{pending.title}</h2>
            {pending.text ? <p className={styles.text}>{pending.text}</p> : null}
            <div className={styles.actions}>
              <Button variant="secondary" onClick={() => close(false)}>
                Отмена
              </Button>
              <Button variant={pending.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
                {pending.confirmLabel}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </ConfirmContext>
  );
}

export function useConfirm(): Ask {
  const ask = useContext(ConfirmContext);
  if (!ask) throw new Error('useConfirm must be used inside ConfirmProvider');
  return ask;
}
