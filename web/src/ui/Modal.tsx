// A centred dialog (search, forms) and a bottom sheet (phone: approvals). Both close on the scrim,
// on Esc, and keep the focus inside while open.
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './Button.tsx';
import { useDialogFocus } from './dialog-focus.ts';
import styles from './overlay.module.css';

export function Modal({ open, onClose, label, children, narrow }: { open: boolean; onClose: () => void; label: string; children: ReactNode; narrow?: boolean }) {
  const box = useDialogFocus(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className={styles.layer}>
      <button type="button" tabIndex={-1} aria-hidden="true" className={styles.scrim} onClick={onClose} />
      <div ref={box} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className={cx(styles.modal, narrow && styles.narrow)}>
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
      <button type="button" tabIndex={-1} aria-hidden="true" className={styles.scrim} onClick={onClose} />
      <div ref={box} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className={styles.sheet}>
        <div className={styles.grip} />
        {children}
      </div>
    </div>,
    document.body,
  );
}
