// «Маскирование» (spec, sections 8.11 and 12; mockup): which personal data the model sees as a
// placeholder — a switch each, saved at once — and an example of what the model gets. Names need a
// recogniser plugin; images and scans go as they are.
import { MASKING_KIND_IDS } from '@bba/contracts';
import { useState } from 'react';
import { Card, PageHead } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Icon } from '../ui/Icon.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { Switch } from '../ui/Switch.tsx';
import { useLoad } from '../ui/use-load.ts';
import { useMedia, WIDE_QUERY } from '../layout/use-media.ts';
import { adminApi } from './api.ts';
import styles from './masking.module.css';
import { Feedback, useAction } from './parts.tsx';
import section from './section.module.css';

type Kind = (typeof MASKING_KIND_IDS)[number];
const KINDS: Record<Kind, { label: string; placeholder: string }> = {
  passport: { label: 'Паспорт РФ', placeholder: '[ПАСПОРТ_1]' },
  snils: { label: 'СНИЛС', placeholder: '[СНИЛС_1]' },
  card: { label: 'Номер банковской карты', placeholder: '[КАРТА_1]' },
  inn: { label: 'ИНН', placeholder: '[ИНН_1]' },
  phone: { label: 'Телефон', placeholder: '[ТЕЛЕФОН_1]' },
  email: { label: 'Электронная почта', placeholder: '[ПОЧТА_1]' },
};
// A made-up message: the example only shows how the switches act.
const SAMPLE_EMAIL = 'a.petrov@example.com';
const SAMPLE_PHONE = '+7 900 123-45-67';

function Example({ kinds }: { kinds: Kind[] }) {
  const email = kinds.includes('email') ? KINDS.email.placeholder : SAMPLE_EMAIL;
  const phone = kinds.includes('phone') ? KINDS.phone.placeholder : SAMPLE_PHONE;
  return (
    <div className={styles.example}>
      <Card className={styles.said}>
        <div className={styles.exampleLabel}>Сотрудник пишет</div>
        <div>
          Отправь КП на <mark className={styles.mark}>{SAMPLE_EMAIL}</mark>, телефон для связи <mark className={styles.mark}>{SAMPLE_PHONE}</mark>
        </div>
      </Card>
      <div className={styles.seen} aria-live="polite">
        <div className={styles.exampleLabel}>Модель видит</div>
        <div className={styles.mono}>
          Отправь КП на <span className={styles.ph}>{email}</span>, телефон для связи <span className={styles.ph}>{phone}</span>
        </div>
      </div>
      <p className={styles.guard}>
        <Icon name="shield" size={16} />
        Если маскирование не сработало, запрос в модель не уходит вовсе.
      </p>
    </div>
  );
}

function Switches({ initial }: { initial: Kind[] }) {
  const [kinds, setKinds] = useState(initial);
  const { busy, error, run } = useAction();
  const wide = useMedia(WIDE_QUERY);
  async function toggle(kind: Kind, on: boolean) {
    const before = kinds;
    const next = on ? MASKING_KIND_IDS.filter((k) => k === kind || kinds.includes(k)) : kinds.filter((k) => k !== kind);
    setKinds(next);
    if (!(await run(() => adminApi.saveMasking(next)))) setKinds(before);
  }
  return (
    <div className={styles.columns}>
      <Card className={`${styles.list} rise`}>
        <Feedback error={error} />
        {MASKING_KIND_IDS.map((k) => (
          <div key={k} className={styles.row}>
            <div className={styles.rowText}>
              <div className={styles.rowName}>{KINDS[k].label}</div>
              <div className={styles.mono}>{KINDS[k].placeholder}</div>
            </div>
            <Switch size={wide ? 'md' : 'lg'} checked={kinds.includes(k)} disabled={busy} label={KINDS[k].label} onChange={(on) => void toggle(k, on)} />
          </div>
        ))}
        <div className={`${styles.row} ${styles.locked}`}>
          <Icon name="lock" />
          <div className={styles.rowText}>
            <div className={styles.rowName}>Имена и фамилии</div>
            <div className={section.sub}>Нужен распознаватель, ставится плагином: ещё 1–2 ГБ памяти</div>
          </div>
        </div>
      </Card>
      <Example kinds={kinds} />
    </div>
  );
}

export function MaskingSection() {
  const { state, reload } = useLoad(adminApi.masking, ['admin', 'masking']);
  return (
    <div className={section.stack}>
      <PageHead title="Маскирование" lead="Скрывать от модели. Модель видит заглушку вроде [ПОЧТА_1], а письма и таблицы получают настоящие данные. Картинки и сканы уходят в модель как есть." />
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? <Switches initial={state.data.kinds as Kind[]} /> : null}
    </div>
  );
}
