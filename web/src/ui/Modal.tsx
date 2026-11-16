// A centred dialog (search, forms) and a bottom sheet (phone: approvals). Both close on the scrim,
// on Esc, and keep the focus inside while open.
import type { MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './Button.tsx';
import { useDialogFocus } from './dialog-focus.ts';
import styles from './overlay.module.css';

// The scrim closes on a single click: the second click of a double click on a row that opened the dialog
// lands on the new scrim and must not close it (a found file, spec section 8.21).
const closeOnSingle = (onClose: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
  if (event.detail <= 1) onClose();
};

// A question that needs an answer before going on («Удалить …?») is an alertdialog. `full` covers
// the whole screen of a phone (search).
export function Modal({ open, onClose, label, children, narrow, full, role = 'dialog' }: { open: boolean; onClose: () => void; label: string; children: ReactNode; narrow?: boolean; full?: boolean; role?: 'dialog' | 'alertdialog' }) {
  const box = useDialogFocus(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className={cx(styles.layer, full && styles.fullLayer)}>
      <button type="button" tabIndex={-1} aria-hidden="true" className={styles.scrim} onClick={closeOnSingle(onClose)} />
      <div ref={box} role={role} aria-modal="true" aria-label={label} tabIndex={-1} className={cx(styles.modal, narrow && styles.narrow, full && styles.full)}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Sheet({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  const box = useDialogFocus(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className={cx(styles.layer, styles.sheetLayer)}>
      <button type="button" tabIndex={-1} aria-hidden="true" className={styles.scrim} onClick={closeOnSingle(onClose)} />
      <div ref={box} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className={styles.sheet}>
        <div className={styles.grip} />
        {children}
      </div>
    </div>,
    document.body,
  );
}
