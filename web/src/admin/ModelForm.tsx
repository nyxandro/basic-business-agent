// A model of the catalog (spec, scenario 9; mockup): what it does — chat or speech recognition,
// its name, «провайдер/модель» as LiteLLM names it, an address for a non-standard provider, the key
// and the prices in roubles. «Проверить и сохранить» checks the key at the provider first:
// «Проверяю ключ…» → «Ключ подошёл». A chat model may come through «Подписка ChatGPT» instead: no
// key and no prices, the accounts of the pool answer. Editing changes the name, «Видит картинки»
// and the prices.
import type { ModelConnection, ModelCreate, ModelDto, ModelKind, TokenPricesInput } from '@bba/contracts';
import { useState } from 'react';
import { Button, cx } from '../ui/Button.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { Modal } from '../ui/Modal.tsx';
import { Switch } from '../ui/Switch.tsx';
import { adminApi } from './api.ts';
import styles from './models.module.css';
import { fromField, toField } from './numbers.ts';
import { Feedback, useAction } from './parts.tsx';
import section from './section.module.css';

const PRICE_FIELDS: { key: keyof TokenPricesInput; label: string }[] = [
  { key: 'input', label: 'Вход' },
  { key: 'output', label: 'Выход' },
  { key: 'cacheRead', label: 'Кэш чтения' },
  { key: 'cacheWrite', label: 'Кэш записи' },
  { key: 'reasoning', label: 'Рассуждения' },
];
const INVALID_PRICE = 'Цены — числа не меньше нуля. Заполните все поля цен.';
type Prices = Record<keyof TokenPricesInput, string>;
type Billing = 'tokens' | 'minute';

const emptyPrices: Prices = { input: '', output: '', cacheRead: '', cacheWrite: '', reasoning: '', image: '' };

function pricesOf(model: ModelDto | null): Prices {
  if (!model?.prices) return emptyPrices;
  const p = model.prices;
  return { input: toField(p.input), output: toField(p.output), cacheRead: toField(p.cacheRead), cacheWrite: toField(p.cacheWrite), reasoning: toField(p.reasoning), image: toField(p.image) };
}

// Every price filled in — an empty one would let the gateway count in its own dollars.
function readPrices(p: Prices): TokenPricesInput | null {
  const out: Partial<Record<keyof TokenPricesInput, number>> = {};
  for (const key of Object.keys(p) as (keyof TokenPricesInput)[]) {
    const v = fromField(p[key], 'rub');
    if (v === 'invalid' || v === null) return null;
    out[key] = v;
  }
  return out as TokenPricesInput;
}

function Chips<V extends string>({ label, value, options, onChange, disabled }: { label: string; value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; disabled?: boolean }) {
  return (
    <div role="group" aria-label={label} className={styles.chips}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} disabled={disabled} className={cx(styles.chip, value === o.value && styles.chipOn)} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ModelFormBody({ model, onClose, onSaved }: { model: ModelDto | null; onClose: () => void; onSaved: () => void }) {
  const editing = model !== null;
  const [kind, setKind] = useState<ModelKind>(model?.kind ?? 'chat');
  const [conn, setConn] = useState<ModelConnection>(model?.connection ?? 'api_key');
  const [label, setLabel] = useState(model?.label ?? '');
  const [providerModel, setProviderModel] = useState(model?.providerModel ?? '');
  const [apiBase, setApiBase] = useState(model?.apiBase ?? '');
  const [key, setKey] = useState('');
  const [vision, setVision] = useState(model?.vision ?? true);
  const [billing, setBilling] = useState<Billing>(model?.pricePerMinute !== null && model?.pricePerMinute !== undefined ? 'minute' : 'tokens');
  const [prices, setPrices] = useState<Prices>(pricesOf(model));
  const [perMinute, setPerMinute] = useState(toField(model?.pricePerMinute ?? null));
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const transcription = kind === 'transcription';
  // Only a chat model comes through the subscription.
  const subscription = conn === 'chatgpt' && !transcription;
  // A chat model has no price per minute; an image price matters only to a chat model.
  const effective: Prices = transcription ? { ...prices, image: prices.image || '0' } : prices;

  async function save() {
    setProblem(null);
    const minute = transcription && billing === 'minute' ? fromField(perMinute, 'rub') : null;
    const tokenPrices = subscription || (transcription && billing === 'minute') ? null : readPrices(effective);
    if (!subscription && !(transcription && billing === 'minute') && tokenPrices === null) return setProblem(INVALID_PRICE);
    if (transcription && billing === 'minute' && (minute === 'invalid' || minute === null)) return setProblem('Цена за минуту — число не меньше нуля.');
    const pricePerMinute = typeof minute === 'number' ? minute : null;
    if (editing) {
      const ok = await run(() => adminApi.updateModel(model.id, { label: label.trim(), vision: transcription ? false : vision, ...(subscription ? {} : { prices: tokenPrices, pricePerMinute }) }));
      if (ok) onSaved();
      return;
    }
    const input: ModelCreate = subscription
      ? { kind: 'chat', label: label.trim(), connection: 'chatgpt', providerModel: providerModel.trim(), vision }
      : { kind, label: label.trim(), connection: 'api_key', providerModel: providerModel.trim(), apiBase: apiBase.trim() || null, vision: transcription ? false : vision, prices: tokenPrices, pricePerMinute, key: key.trim() };
    if (await run(() => adminApi.createModel(input), subscription ? 'Модель добавлена' : 'Ключ подошёл')) onSaved();
  }

  return (
    <form
      className={section.form}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className={section.formTitle}>{editing ? model.label : 'Добавить модель'}</h2>
      <Feedback error={error} />
      <Chips
        label="Что делает модель"
        value={kind}
        disabled={editing}
        onChange={setKind}
        options={[
          { value: 'chat', label: 'Модель чата' },
          { value: 'transcription', label: 'Распознавание речи' },
        ]}
      />
      {transcription ? null : (
        <Chips
          label="Подключение"
          value={conn}
          disabled={editing}
          onChange={setConn}
          options={[
            { value: 'api_key', label: 'Ключ провайдера' },
            { value: 'chatgpt', label: 'Подписка ChatGPT' },
          ]}
        />
      )}
      {subscription && !editing ? <p className={section.note}>Без ключа и цен: запросы идут через аккаунты пула, токены считаются в дневной потолок сотрудника.</p> : null}
      <div className={section.row}>
        <Field label="Название">
          <Input required value={label} onChange={(e) => setLabel(e.target.value)} placeholder="GigaChat 2 Max" />
        </Field>
        <Field label="Провайдер и модель" hint={subscription ? 'chatgpt/ и модель подписки.' : 'Как в LiteLLM: провайдер/модель.'}>
          <Input mono required disabled={editing} value={providerModel} onChange={(e) => setProviderModel(e.target.value)} placeholder={subscription ? 'chatgpt/gpt-5.4' : 'openai/gpt-4.1-mini'} />
        </Field>
      </div>
      {editing || subscription ? null : (
        <div className={section.row}>
          <Field label="Адрес провайдера (если не стандартный)">
            <Input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="https://…" />
          </Field>
          <Field label="Ключ">
            <Input type="password" autoComplete="off" required value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
        </div>
      )}
      {transcription ? null : (
        <div className={styles.switchRow}>
          <div>
            <div className={styles.switchTitle}>Видит картинки</div>
            <div className={section.sub}>Основной и запасной нужна модель с картинками — иначе агенты не прочитают сканы.</div>
          </div>
          <Switch checked={vision} label="Видит картинки" onChange={setVision} />
        </div>
      )}
      {subscription ? null : (
        <>
          {transcription ? (
            <Chips
              label="Цена распознавания"
              value={billing}
              onChange={setBilling}
              options={[
                { value: 'minute', label: 'За минуту' },
                { value: 'tokens', label: 'По токенам' },
              ]}
            />
          ) : null}
          {transcription && billing === 'minute' ? (
            <Field label="Цена, ₽ за минуту">
              <Input inputMode="decimal" value={perMinute} onChange={(e) => setPerMinute(e.target.value)} />
            </Field>
          ) : (
            <fieldset className={styles.prices}>
              <legend className={styles.legend}>Цены, ₽ за 1 млн токенов</legend>
              <div className={styles.priceGrid}>
                {PRICE_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label}>
                    <Input inputMode="decimal" value={prices[f.key]} onChange={(e) => setPrices((p) => ({ ...p, [f.key]: e.target.value }))} />
                  </Field>
                ))}
                {transcription ? null : (
                  <Field label="Картинка, ₽">
                    <Input inputMode="decimal" value={prices.image} onChange={(e) => setPrices((p) => ({ ...p, image: e.target.value }))} />
                  </Field>
                )}
              </div>
            </fieldset>
          )}
        </>
      )}
      {problem ? (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      ) : null}
      <div className={section.formActions}>
        <Button onClick={onClose}>Отмена</Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {editing || subscription ? 'Сохранить' : busy ? 'Проверяю ключ…' : 'Проверить и сохранить'}
        </Button>
      </div>
    </form>
  );
}

export function ModelForm({ model, onClose, onSaved }: { model: ModelDto | null; onClose: () => void; onSaved: () => void }) {
  return (
    <Modal open onClose={onClose} label={model ? model.label : 'Добавить модель'}>
      <ModelFormBody model={model} onClose={onClose} onSaved={onSaved} />
    </Modal>
  );
}
