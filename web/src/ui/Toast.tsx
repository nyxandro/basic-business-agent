// A short notice at the bottom right after a save («Сохранено», «Задача создана»); it goes away by
// itself in 2.4 s. Errors are not toasts: they stay next to what failed.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import styles from './overlay.module.css';

const TOAST_MS = 2400;

const ToastContext = createContext<((text: string) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((next: string) => {
    clearTimeout(timer.current);
    setText(next);
    timer.current = setTimeout(() => setText(null), TOAST_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext value={value}>
      {children}
      {text ? (
        <div className={styles.toast} role="status">
          <Icon name="check" />
          {text}
        </div>
      ) : null}
    </ToastContext>
  );
}

export function useToast(): (text: string) => void {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast must be used inside ToastProvider');
  return show;
}
