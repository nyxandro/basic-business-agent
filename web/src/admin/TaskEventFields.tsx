// The part of a task's form for a start by an event (docs/specs/[20.11.2026]-event-tasks.md, sections 7 and 12): a
// letter in an employee's mailbox — the filters and «Сработает у N из M»; a message of another system — on whose
// behalf the agent works, and once the task is saved its address with «Скопировать» and «Сменить адрес».
import type { AdminPerson, AdminTask, MailReachResponse, TaskAccess } from '@bba/contracts';
import { useEffect, useState } from 'react';
import { Button } from '../ui/Button.tsx';
import { Field, Input, Select } from '../ui/Field.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { useToast } from '../ui/Toast.tsx';
import { accessIsEmpty } from './AccessPicker.tsx';
import { adminApi } from './api.ts';
import { Feedback, useAction } from './parts.tsx';
import section from './section.module.css';
import models from './models.module.css';
import styles from './tasks.module.css';

export function MailFilterFields({ from, subject, onFrom, onSubject }: { from: string; subject: string; onFrom: (v: string) => void; onSubject: (v: string) => void }) {
  return (
    <div className={section.row}>
      <Field label="От кого — адреса или домены через запятую" hint="Пусто — от любого отправителя.">
        <Input value={from} onChange={(e) => onFrom(e.target.value)} placeholder="sale@vector.ru, vector.ru" />
      </Field>
      <Field label="Тема содержит — слова через запятую" hint="Подходит любое слово; «ё» и «е» не различаются. Пусто — любая тема.">
        <Input value={subject} onChange={(e) => onSubject(e.target.value)} placeholder="заказ, счёт" />
      </Field>
    </div>
  );
}

// «Сработает у 6 из 8: у двоих не подключена почта» — for the area and the agent chosen now.
export function MailReach({ agentId, access }: { agentId: string; access: TaskAccess }) {
  const [reach, setReach] = useState<MailReachResponse | null>(null);
  const key = JSON.stringify([agentId, access]);
  useEffect(() => {
    if (!agentId || accessIsEmpty(access)) return;
    let live = true;
    void adminApi.mailReach(agentId, access).then(
      (r) => live && setReach(r),
      () => live && setReach(null),
    );
    return () => {
      live = false;
    };
    // `key` names everything the count depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!reach) return null;
  if (reach.withMail === 0) return <p className={styles.warnNote}>Ни у кого из выбранных сотрудников не подключена почта — задача не сработает. Код: APP_TASK_NO_MAILBOX</p>;
  const without = reach.total - reach.withMail;
  return <p className={section.note}>{without > 0 ? `Сработает у ${reach.withMail} из ${reach.total}: у ${without} не подключена почта.` : `Сработает у всех ${reach.total}.`}</p>;
}

export function ExecutorField({ value, users, onChange }: { value: string; users: AdminPerson[]; onChange: (v: string) => void }) {
  return (
    <Field label="От чьего имени работает агент" hint="Каждое сообщение — запуск агента с доступами и лимитами этого сотрудника; действия наружу ждут его «Да».">
      <Select required value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Выберите сотрудника</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

// The address of a saved webhook task: always visible; a new one stops the old.
export function HookAddress({ task, onRenewed }: { task: AdminTask; onRenewed: (task: AdminTask) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { busy, error, run } = useAction();
  if (!task.hookUrl) return null;
  const url = task.hookUrl;
  return (
    <fieldset className={styles.hook}>
      <legend className={models.legend}>Адрес для другой системы</legend>
      <Feedback error={error} />
      <div className={styles.hookRow}>
        <code className={styles.hookUrl}>{url}</code>
        <Button
          icon="copy"
          onClick={() =>
            void navigator.clipboard?.writeText(url).then(
              () => toast('Адрес скопирован'),
              () => undefined,
            )
          }
        >
          Скопировать
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            void confirm({ title: 'Сменить адрес задачи?', text: 'Старый адрес перестанет работать сразу: другой системе нужно будет вписать новый.', confirmLabel: 'Сменить адрес', danger: true }).then(async (yes) => {
              if (yes) await run(async () => onRenewed(await adminApi.renewHook(task.id)), 'Адрес сменён');
            })
          }
        >
          Сменить адрес
        </Button>
      </div>
      <p className={section.note}>Старый адрес перестанет работать. Сообщения — JSON или форма, до 64 КБ.</p>
      {url.startsWith('http:') ? <p className={styles.warnNote}>Секрет адреса уйдёт по сети открытым текстом. Настройте https у установки.</p> : null}
    </fieldset>
  );
}
