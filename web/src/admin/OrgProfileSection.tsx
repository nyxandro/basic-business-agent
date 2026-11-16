// «Профиль организации» (spec, scenario 5; mockup): the name, the industry, the tone of answers and
// the requisites — they go into the prompt of every agent. The tone is a preset or one's own words.
import { useState } from 'react';
import { Button, cx } from '../ui/Button.tsx';
import { Card, PageHead } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input, TextArea } from '../ui/Field.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { adminApi } from './api.ts';
import styles from './org.module.css';
import { Feedback, useAction } from './parts.tsx';
import section from './section.module.css';

type Profile = { name: string; tone: string; requisites: string; industry: string };

const TONES = [
  { name: 'Деловой', text: 'Деловой: на «вы», коротко и по делу, без лишних эмоций.' },
  { name: 'Дружелюбный', text: 'Дружелюбный: на «вы», тепло и просто, без канцелярита.' },
  { name: 'Краткий', text: 'Краткий: только суть, без вступлений и повторов.' },
];

function ProfileForm({ initial }: { initial: Profile }) {
  const [form, setForm] = useState(initial);
  const { busy, error, run } = useAction();
  const set = (key: keyof Profile) => (e: { target: { value: string } }) => setForm((prev) => ({ ...prev, [key]: e.target.value }));
  const tone = TONES.find((t) => t.text === form.tone)?.name ?? null;
  return (
    <Card className={`${styles.card} rise`}>
      <Feedback error={error} />
      <Field label="Название">
        <Input required value={form.name} onChange={set('name')} />
      </Field>
      <Field label="Отрасль">
        <Input value={form.industry} onChange={set('industry')} />
      </Field>
      <div className={styles.tone}>
        <div className={styles.label}>Тон общения</div>
        <div role="radiogroup" aria-label="Тон общения" className={styles.segment}>
          {TONES.map((t) => (
            <button key={t.name} type="button" role="radio" aria-checked={tone === t.name} className={cx(styles.option, tone === t.name && styles.optionOn)} onClick={() => setForm((prev) => ({ ...prev, tone: t.text }))}>
              {t.name}
            </button>
          ))}
        </div>
        <TextArea aria-label="Тон общения своими словами" rows={2} value={form.tone} onChange={set('tone')} />
      </div>
      <Field label="Реквизиты">
        <TextArea rows={4} value={form.requisites} onChange={set('requisites')} />
      </Field>
      <div className={styles.foot}>
        <span className={section.sub}>Подставляется в промпт всех агентов при каждом запросе.</span>
        <Button variant="primary" disabled={busy || !form.name.trim()} onClick={() => void run(() => adminApi.saveOrgProfile(form))}>
          Сохранить
        </Button>
      </div>
    </Card>
  );
}

export function OrgProfileSection() {
  // A form starts from what it loads: loaded anew at every opening, never from memory (spec, section 8.22).
  const { state, reload } = useLoad(adminApi.orgProfile);
  return (
    <div className={cx(section.stack, styles.page)}>
      <PageHead title="Профиль организации" lead="Подставляется в промпт всех агентов." />
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? <ProfileForm initial={state.data} /> : null}
    </div>
  );
}
