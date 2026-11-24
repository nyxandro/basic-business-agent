// A screen that failed to draw shows a plain message with a code and a reload instead of a blank
// page; the frame around it (side panel, admin menu) stays. The failure goes to the console once.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './Button.tsx';
import { uiErrorTexts } from '../i18n/ui-errors.ts';
import styles from './feedback.module.css';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('ui render failed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={styles.crash} role="alert">
        <p className={styles.crashTitle}>Экран не открылся</p>
        <p>Обновите страницу. Если повторится — сообщите администратору код APP_UI_FAILED.</p>
        <Button variant="primary" onClick={() => window.location.reload()}>
          Обновить страницу
        </Button>
      </div>
    );
  }
}

// One part of a screen — a message of a conversation — that failed to draw: a short note in its place, the rest of the
// screen stays (review 24.11). The whole-screen boundary above would otherwise take the conversation away, and again
// after every reload, since the same message draws the same way.
export class PartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('ui part render failed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <p className={styles.partCrash} role="note">
        {uiErrorTexts.partFailed} <span className={styles.partCode}>{uiErrorTexts.partCode}</span>
      </p>
    );
  }
}
