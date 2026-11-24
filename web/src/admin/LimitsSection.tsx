// «Настройки лимитов» (spec, scenario 5, F5; mockup): the organisation ceiling, the default per
// employee, the daily token cap of subscription models, and one person's own limit on top of the
// defaults. An empty field means «без лимита» (or «по умолчанию» for a person).
import type { AdminUser, LimitSettingsBody, PersonalLimit } from '@bba/contracts';
import { useState } from 'react';
import { Button } from '../ui/Button.tsx';
import { Card } from '../ui/Display.tsx';
import { Field, Input, Select } from '../ui/Field.tsx';
import { rub } from '../i18n/format.ts';
import { adminApi } from './api.ts';
import { fromField, toField } from './numbers.ts';
import { Feedback, useAction } from '../ui/form-parts.tsx';
import styles from './limits.module.css';

const INVALID = 'Нужно число не меньше нуля; для токенов — целое.';

export interface LimitsData {
  limits: LimitSettingsBody;
  personal: PersonalLimit[];
  users: AdminUser[];
}

export function LimitsSection({ data, onSaved }: { data: LimitsData; onSaved: () => void }) {
  const [org, setOrg] = useState(toField(data.limits.orgMonthlyRub));
  const [user, setUser] = useState(toField(data.limits.defaultUserMonthlyRub));
  const [daily, setDaily] = useState(toField(data.limits.defaultDailySubscriptionTokens));
  const own = new Map(data.personal.map((p) => [p.userId, p]));
  const [personId, setPersonId] = useState('');
  const [monthly, setMonthly] = useState('');
  const [tokens, setTokens] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const choose = (id: string) => {
    setPersonId(id);
    setMonthly(toField(own.get(id)?.monthlyRub ?? null));
    setTokens(toField(own.get(id)?.dailySubscriptionTokens ?? null));
  };
  const ownText = (u: AdminUser) => {
    const value = own.get(u.id)?.monthlyRub;
    return `${u.name}: ${value === undefined || value === null ? 'без личного лимита' : rub(value)}`;
  };

  async function save() {
    const values = [fromField(org, 'rub'), fromField(user, 'rub'), fromField(daily, 'tokens')];
    const person = personId ? [fromField(monthly, 'rub'), fromField(tokens, 'tokens')] : [];
    if ([...values, ...person].includes('invalid')) return setProblem(INVALID);
    setProblem(null);
    const [orgMonthlyRub, defaultUserMonthlyRub, defaultDailySubscriptionTokens] = values as (number | null)[];
    const ok = await run(async () => {
      await adminApi.saveLimits({ orgMonthlyRub: orgMonthlyRub!, defaultUserMonthlyRub: defaultUserMonthlyRub!, defaultDailySubscriptionTokens: defaultDailySubscriptionTokens! });
      if (personId) await adminApi.savePersonalLimit(personId, person[0] as number | null, person[1] as number | null);
    });
    if (ok) onSaved();
  }

  return (
    <Card className={`${styles.card} rise`}>
      <h2 className={styles.cardTitle}>Настройки лимитов</h2>
      <Feedback error={error} />
      <Field label="Общий потолок организации, ₽ в месяц" hint="Пусто — без потолка.">
        <Input inputMode="decimal" value={org} onChange={(e) => setOrg(e.target.value)} />
      </Field>
      <Field label="Лимит сотрудника по умолчанию, ₽ в месяц" hint="Пусто — без лимита.">
        <Input inputMode="decimal" value={user} onChange={(e) => setUser(e.target.value)} />
      </Field>
      <Field label="Подписка ChatGPT: токенов в день на сотрудника" hint="Пусто — без потолка.">
        <Input inputMode="numeric" value={daily} onChange={(e) => setDaily(e.target.value)} />
      </Field>
      <Field label="Личный лимит">
        <Select value={personId} onChange={(e) => choose(e.target.value)}>
          <option value="">Выберите сотрудника</option>
          {data.users.map((u) => (
            <option key={u.id} value={u.id}>
              {ownText(u)}
            </option>
          ))}
        </Select>
      </Field>
      {personId ? (
        <div className={styles.personal}>
          <Field label="₽ в месяц" hint="Пусто — по умолчанию.">
            <Input inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
          </Field>
          <Field label="Токенов в день" hint="Пусто — по умолчанию.">
            <Input inputMode="numeric" value={tokens} onChange={(e) => setTokens(e.target.value)} />
          </Field>
        </div>
      ) : null}
      {problem ? (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      ) : null}
      <Button variant="primary" className={styles.save} disabled={busy} onClick={() => void save()}>
        Сохранить
      </Button>
    </Card>
  );
}
