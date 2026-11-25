// A model of the catalog (spec, scenario 9; mockup): what it does — chat or speech recognition,
// its name, «провайдер/модель» as LiteLLM names it, an address for a non-standard provider, the key
// and the prices in roubles. «Проверить и сохранить» checks the key at the provider first:
// «Проверяю ключ…» → «Ключ подошёл». A chat model may come through «Подписка ChatGPT» instead: no
// key and no prices, the accounts of the pool answer. Editing changes the name, «Видит картинки»,
// the prices and the provider's address (owner's list 16.11) — a new address is checked with the
// model's keys first, so the button says «Проверить и сохранить» then. The keys go to the new
// address, so only the superadmin may change it; others see it. The longest answer of a chat model comes from the gateway; only when the gateway
// does not know the model (APP_MODEL_OUTPUT_LIMIT_REQUIRED) or the provider refuses its limit
// (APP_MODEL_OUTPUT_LIMIT_REJECTED) the form asks for it (spec, section 8.19). The size of the context of a chat model
// is optional (decision of the owner 25.11, section 8.34): empty — the gateway's or the provider's, or none, and then the chat does not
// show how full a conversation is.
import { CONTEXT_SIZE_MAX, type ModelConnection, type ModelCreate, type ModelDto, type ModelKind, type TokenPricesInput } from '@bba/contracts';
import { useState } from 'react';
import { useMe } from '../auth/session.tsx';
import { Button, cx } from '../ui/Button.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { Modal } from '../ui/Modal.tsx';
import { Switch } from '../ui/Switch.tsx';
import { adminApi } from './api.ts';
import styles from './models.module.css';
import chips from '../ui/chips.module.css';
import { fromField, toField } from './numbers.ts';
import { Feedback, useAction } from '../ui/form-parts.tsx';
import section from './section.module.css';

const PRICE_FIELDS: { key: keyof TokenPricesInput; label: string }[] = [
  { key: 'input', label: 'Вход' },
  { key: 'output', label: 'Выход' },
  { key: 'cacheRead', label: 'Кэш чтения' },
  { key: 'cacheWrite', label: 'Кэш записи' },
  { key: 'reasoning', label: 'Рассуждения' },
];
const INVALID_PRICE = 'Цены — числа не меньше нуля. Заполните все поля цен.';
// Why the form asks for the limit, by the server's code: the gateway does not know the model, or the
// provider refused the limit the gateway knows (#7).
const LIMIT_HINTS: Record<string, string> = {
  APP_MODEL_OUTPUT_LIMIT_REQUIRED: 'Шлюз не знает эту модель — число есть в её описании у провайдера.',
  APP_MODEL_OUTPUT_LIMIT_REJECTED: 'Провайдер не принял прежнее число — укажите меньшее, оно есть в описании модели у провайдера.',
};
const LIMIT_LABEL = 'Наибольшая длина ответа, токенов';
const INVALID_LIMIT = 'Длина ответа — целое число токенов больше нуля.';
const CONTEXT_LABEL = 'Размер контекста, токенов';
const CONTEXT_HINT = 'Можно не заполнять: размер знают шлюз и многие провайдеры. Без него в чате не видно, насколько заполнен разговор.';
const INVALID_CONTEXT = 'Размер контекста — целое число токенов больше нуля. Или оставьте поле пустым.';
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
    <div role="group" aria-label={label} className={chips.row}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} disabled={disabled} className={cx(chips.chip, value === o.value && chips.on)} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ModelFormBody({ model, onClose, onSaved }: { model: ModelDto | null; onClose: () => void; onSaved: () => void }) {
  const editing = model !== null;
  const mayMove = useMe().isSuperadmin;
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
  const [limit, setLimit] = useState('');
  const [context, setContext] = useState(toField(model ? model.maxInputTokens : null));
  // The code that asked for the limit: stays once asked, the server's error goes away with the next attempt.
  const [limitAskedBy, setLimitAskedBy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { busy, error, run, clearError } = useAction();
  const transcription = kind === 'transcription';
  // Only a chat model comes through the subscription.
  const subscription = conn === 'chatgpt' && !transcription;
  // A chat model has no price per minute; an image price matters only to a chat model.
  const effective: Prices = transcription ? { ...prices, image: prices.image || '0' } : prices;
  const askedBy = error && error.code in LIMIT_HINTS ? error.code : limitAskedBy;
  const askLimit = !editing && !subscription && !transcription && askedBy !== null;
  // Empty — the provider's standard address.
  const address = apiBase.trim() || null;
  const moved = editing && !subscription && address !== model.apiBase;

  // The limit was asked for that model: the gateway may know another one, so the server decides again.
  function changeProviderModel(value: string) {
    setProviderModel(value);
    if (!askLimit) return;
    setLimitAskedBy(null);
    setLimit('');
    clearError();
  }

  async function save() {
    setProblem(null);
    const minute = transcription && billing === 'minute' ? fromField(perMinute, 'rub') : null;
    const tokenPrices = subscription || (transcription && billing === 'minute') ? null : readPrices(effective);
    if (!subscription && !(transcription && billing === 'minute') && tokenPrices === null) return setProblem(INVALID_PRICE);
    if (transcription && billing === 'minute' && (minute === 'invalid' || minute === null)) return setProblem('Цена за минуту — число не меньше нуля.');
    const pricePerMinute = typeof minute === 'number' ? minute : null;
    // «16 384» is how people write it.
    const maxOutputTokens = askLimit ? fromField(limit.replace(/\s/g, ''), 'tokens') : null;
    if (askLimit) setLimitAskedBy(askedBy);
    if (maxOutputTokens === 'invalid' || (askLimit && maxOutputTokens === null)) return setProblem(INVALID_LIMIT);
    const maxInputTokens = transcription ? null : fromField(context.replace(/\s/g, ''), 'tokens');
    if (maxInputTokens === 'invalid' || (maxInputTokens !== null && maxInputTokens > CONTEXT_SIZE_MAX)) return setProblem(INVALID_CONTEXT);
    if (editing) {
      // An unchanged size is not sent; an emptied one is null — the server takes the gateway's again.
      const contextChanged = !transcription && maxInputTokens !== model.maxInputTokens;
      const change = {
        label: label.trim(),
        vision: transcription ? false : vision,
        ...(subscription ? {} : { prices: tokenPrices, pricePerMinute }),
        ...(moved ? { apiBase: address } : {}),
        ...(contextChanged ? { maxInputTokens } : {}),
      };
      if (await run(() => adminApi.updateModel(model.id, change), moved ? 'Ключ подошёл' : undefined)) onSaved();
      return;
    }
    const input: ModelCreate = subscription
      ? { kind: 'chat', label: label.trim(), connection: 'chatgpt', providerModel: providerModel.trim(), vision, maxInputTokens }
      : { kind, label: label.trim(), connection: 'api_key', providerModel: providerModel.trim(), apiBase: address, vision: transcription ? false : vision, prices: tokenPrices, pricePerMinute, key: key.trim(), maxOutputTokens, maxInputTokens };
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
          <Input mono required disabled={editing} value={providerModel} onChange={(e) => changeProviderModel(e.target.value)} placeholder={subscription ? 'chatgpt/gpt-5.4' : 'openai/gpt-4.1-mini'} />
        </Field>
      </div>
      {subscription ? null : (
        <div className={section.row}>
          <Field label="Адрес провайдера (если не стандартный)" hint={editing ? (mayMove ? 'Новый адрес проверяется ключами модели.' : 'Адрес меняет только суперадминистратор: на новый адрес уходят ключи модели.') : undefined}>
            <Input value={apiBase} disabled={editing && !mayMove} onChange={(e) => setApiBase(e.target.value)} placeholder="https://…" />
          </Field>
          {/* An added model's keys are changed in «Ключи». */}
          {editing ? null : (
            <Field label="Ключ">
              <Input type="password" autoComplete="off" required value={key} onChange={(e) => setKey(e.target.value)} />
            </Field>
          )}
        </div>
      )}
      {askLimit ? (
        <Field label={LIMIT_LABEL} hint={askedBy ? LIMIT_HINTS[askedBy] : undefined}>
          <Input inputMode="numeric" required value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="16 384" />
        </Field>
      ) : null}
      {transcription ? null : (
        <Field label={CONTEXT_LABEL} hint={CONTEXT_HINT}>
          <Input inputMode="numeric" value={context} onChange={(e) => setContext(e.target.value)} placeholder="128 000" />
        </Field>
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
          {(editing && !moved) || subscription ? 'Сохранить' : busy ? 'Проверяю ключ…' : 'Проверить и сохранить'}
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
