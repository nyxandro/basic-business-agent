// «Режимы работы» → «Подтверждения» (docs/specs/[20.11.2026]-notifications.md, F4): how long a question «Да» waits
// before it burns — one of a conversation (a day at first) and one of a background task (72 hours at first). A new term
// is for new questions; those asked before keep theirs.
import { APPROVAL_TTL_HOURS_MAX, APPROVAL_TTL_HOURS_MIN, type ApprovalSettingsDto } from '@bba/contracts';
import { useState } from 'react';
import { notificationTexts } from '../i18n/notifications.ts';
import { Button } from '../ui/Button.tsx';
import { Card, CardHead } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import { Feedback, useAction } from '../ui/form-parts.tsx';
import styles from './tasks.module.css';

const t = notificationTexts.modes;

function hoursOf(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= APPROVAL_TTL_HOURS_MIN && n <= APPROVAL_TTL_HOURS_MAX ? n : null;
}

// A form: loaded afresh each time, never from the memory of screens (it would show the terms from before a save).
export function ApprovalTerms() {
  const { state, reload } = useLoad(adminApi.approvalSettings);
  return (
    <Card className="rise">
      <CardHead title={t.title} sub={t.sub} />
      <div className={styles.termsBody}>
        {state.status === 'loading' ? <DelayedBar /> : null}
        {state.status === 'error' ? <ErrorBanner title={t.loadFailed} error={state.error} onRetry={reload} /> : null}
        {state.status === 'ready' ? <TermsForm initial={state.data} /> : null}
      </div>
    </Card>
  );
}

function TermsForm({ initial }: { initial: ApprovalSettingsDto }) {
  const [chat, setChat] = useState(String(initial.chatTtlHours));
  const [background, setBackground] = useState(String(initial.backgroundTtlHours));
  const [problem, setProblem] = useState(false);
  const { busy, error, run } = useAction();

  async function save() {
    const chatTtlHours = hoursOf(chat);
    const backgroundTtlHours = hoursOf(background);
    if (chatTtlHours === null || backgroundTtlHours === null) return setProblem(true);
    setProblem(false);
    await run(() => adminApi.saveApprovalSettings({ chatTtlHours, backgroundTtlHours }), t.saved);
  }

  return (
    <>
      <div className={styles.terms}>
        <Field label={`${t.chat}, ${t.hours}`} error={problem && hoursOf(chat) === null ? t.range : null}>
          <Input inputMode="numeric" value={chat} onChange={(e) => setChat(e.target.value)} />
        </Field>
        <Field label={`${t.background}, ${t.hours}`} error={problem && hoursOf(background) === null ? t.range : null}>
          <Input inputMode="numeric" value={background} onChange={(e) => setBackground(e.target.value)} />
        </Field>
      </div>
      <p className={styles.termsNote}>{t.note}</p>
      <Feedback error={error} />
      <Button variant="primary" disabled={busy} onClick={() => void save()}>
        {t.save}
      </Button>
    </>
  );
}
