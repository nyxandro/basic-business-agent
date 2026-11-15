// A short notice at the bottom right after a save («Сохранено», «Задача создана»); it goes away by
// itself in 2.4 s. One that can be undone («Файл в корзине» — «Вернуть») stays 6 s. Errors are not
// toasts: they stay next to what failed.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import styles from './overlay.module.css';

const TOAST_MS = 2400;
const TOAST_WITH_ACTION_MS = 6000;

export interface ToastAction {
  label: string;
  run: () => void;
}

type Show = (text: string, action?: ToastAction) => void;

const ToastContext = createContext<Show | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; action: ToastAction | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback<Show>((text, action) => {
    clearTimeout(timer.current);
    setToast({ text, action: action ?? null });
    timer.current = setTimeout(() => setToast(null), action ? TOAST_WITH_ACTION_MS : TOAST_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext value={value}>
      {children}
      {toast ? (
        <div className={styles.toast} role="status">
          <Icon name="check" />
          {toast.text}
          {toast.action ? (
            <button
              type="button"
              className={styles.toastAction}
              onClick={() => {
                clearTimeout(timer.current);
                setToast(null);
                toast.action!.run();
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </ToastContext>
  );
}

export function useToast(): Show {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast must be used inside ToastProvider');
  return show;
}
