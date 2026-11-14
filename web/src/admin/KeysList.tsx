// Keys of a model (spec, scenario 9): each shows only its last 4 characters; a new key is checked
// at the provider first («Проверяю ключ…»), the last key cannot go — the server says why.
import type { ModelDto } from '@bba/contracts';
import { useState } from 'react';
import { Button, IconButton } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { dateTime } from '../ui/format.ts';
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';
import { adminApi } from './api.ts';
import styles from './models.module.css';
import { Feedback, useAction } from './parts.tsx';
import section from './section.module.css';

export function KeysList({ model, onClose, onChanged }: { model: ModelDto; onClose: () => void; onChanged: () => void }) {
  const [key, setKey] = useState('');
  const [adding, setAdding] = useState(false);
  const { busy, error, run } = useAction();
  const confirm = useConfirm();
  async function add() {
    setAdding(true);
    const ok = await run(() => adminApi.addModelKey(model.id, key.trim()), 'Ключ подошёл');
    setAdding(false);
    if (ok) {
      setKey('');
      onChanged();
    }
  }
  async function remove(keyId: string, last4: string) {
    if (!(await confirm({ title: `Удалить ключ …${last4}?`, text: 'Запросы пойдут через остальные ключи модели.', confirmLabel: 'Удалить', danger: true }))) return;
    if (await run(() => adminApi.deleteModelKey(model.id, keyId), 'Ключ удалён')) onChanged();
  }
  return (
    <Modal open onClose={onClose} label={`Ключи: ${model.label}`}>
      <div className={section.form}>
        <h2 className={section.formTitle}>Ключи: {model.label}</h2>
        <p className={section.note}>Запросы раздаются по ключам по кругу; ключ целиком не показывается никому.</p>
        <Feedback error={error} />
        <ul className={styles.keys}>
          {model.keys.map((k) => (
            <li key={k.id} className={styles.key}>
              <Icon name="key" size={16} />
              <span className={styles.keyText}>
                Ключ сохранён · …{k.last4}
                <span className={section.sub}> · {dateTime(k.createdAt)}</span>
              </span>
              <IconButton icon="trash" label={`Удалить ключ …${k.last4}`} disabled={busy} onClick={() => void remove(k.id, k.last4)} />
            </li>
          ))}
        </ul>
        <form
          className={styles.addKey}
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <Field label="Новый ключ">
            <Input type="password" autoComplete="off" required value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" disabled={busy || !key.trim()}>
            {adding ? 'Проверяю ключ…' : 'Добавить ключ'}
          </Button>
        </form>
      </div>
    </Modal>
  );
}
