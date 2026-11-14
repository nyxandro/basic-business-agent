// Focus inside an open dialog: the first field gets it, Tab stays inside, Esc closes, and on close
// the focus goes back to where it was (the button that opened the dialog). With a dialog over
// another (a question over an editor) only the top one answers keys.
import { useEffect, useEffectEvent, useRef, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open dialogs in the order they opened. Dialogs are a single stack on the page by nature, so the
// stack lives at module level; each dialog adds and removes only itself.
const openDialogs: object[] = [];

export function useDialogFocus(open: boolean, onClose: () => void): RefObject<HTMLDivElement | null> {
  const box = useRef<HTMLDivElement>(null);
  const close = useEffectEvent(onClose);

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const node = box.current;
    const items = () => Array.from(node?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = node?.querySelector<HTMLElement>('input, textarea, select') ?? items()[0];
    (first ?? node)?.focus();

    const self = {};
    openDialogs.push(self);
    const onKey = (event: KeyboardEvent) => {
      if (openDialogs.at(-1) !== self) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const list = items();
      if (list.length === 0) return;
      const head = list[0]!;
      const tail = list[list.length - 1]!;
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      openDialogs.splice(openDialogs.indexOf(self), 1);
      before?.focus?.();
    };
  }, [open]);

  return box;
}
