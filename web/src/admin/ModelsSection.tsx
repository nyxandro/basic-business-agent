// «Нейросеть» (spec, scenario 9; mockup; owner's list 16.11): the state of the model gateway, the
// catalog of models with prices in roubles and a switch each, their keys, the pool of ChatGPT
// accounts and the parameters. The tiles of the organisation's choice are gone (owner's list 16.11):
// the roles stand in the catalog, the choice — in «Параметры». Everything goes to LiteLLM; our database is the
// source of truth.
import type { ChatGptAccountDto, ModelDto, ModelSettings, ModelsResponse } from '@bba/contracts';
import { useState } from 'react';
import { Button, cx, IconButton } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, EmptyState, PageHead, Pill } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { dateTime, plural } from '../ui/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { Menu, MenuAnchor, MenuItem, MenuSeparator } from '../ui/Menu.tsx';
import { Switch } from '../ui/Switch.tsx';
import { numCell, Table } from '../ui/Table.tsx';
import { useLoad } from '../ui/use-load.ts';
import { useMedia, WIDE_QUERY } from '../layout/use-media.ts';
import { AccountsPool } from './AccountsPool.tsx';
import { adminApi } from './api.ts';
import { KeysList } from './KeysList.tsx';
import { ModelForm } from './ModelForm.tsx';
import { ModelParams } from './ModelParams.tsx';
import styles from './models.module.css';
import { Feedback, useAction } from './parts.tsx';
import section from './section.module.css';

const money = (v: number) => v.toLocaleString('ru-RU', { maximumFractionDigits: 2 });

function role(m: ModelDto, s: ModelSettings): { text: string; tone: 'accent' | 'neutral' } | null {
  if (m.id === s.primaryModelId) return { text: 'Основная', tone: 'accent' };
  if (m.id === s.fallbackModelId) return { text: 'Запасная', tone: 'neutral' };
  if (m.id === s.transcriptionModelId) return { text: 'Распознавание', tone: 'neutral' };
  if (m.agentIds.length > 0) return { text: `Своя у агентов: ${m.agentIds.length}`, tone: 'neutral' };
  return null;
}

function connection(m: ModelDto, accounts: ChatGptAccountDto[]): string {
  // «пул из 3 аккаунтов», as in the mockup.
  if (m.connection === 'chatgpt') return accounts.length > 0 ? `пул из ${accounts.length} ${plural(accounts.length, ['аккаунта', 'аккаунтов', 'аккаунтов'])}` : 'подписка ChatGPT · нет аккаунтов';
  const keys = m.keys.length;
  return keys === 1 ? `ключ организации · …${m.keys[0]!.last4}` : `ключей: ${keys}`;
}

function Gateway({ gateway }: { gateway: ModelsResponse['gateway'] }) {
  const pending = gateway.pendingModelIds.length;
  if (!gateway.reachable) {
    return (
      <span className={cx(styles.gateway, styles.gatewayBad)}>
        <span className={styles.dot} />
        Шлюз моделей не отвечает · {dateTime(gateway.checkedAt)}
      </span>
    );
  }
  return (
    <span className={cx(styles.gateway, pending > 0 && styles.gatewayWarn)}>
      <span className={cx(styles.dot, styles.pulse)} />
      {pending > 0 ? `Шлюз применяет изменения: ${pending}` : `Шлюз работает · проверено ${dateTime(gateway.checkedAt)}`}
    </span>
  );
}

function RowMenu({ model, onEdit, onKeys, onChanged }: { model: ModelDto; onEdit: () => void; onKeys: () => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const confirm = useConfirm();
  const { error, run } = useAction();
  const label = `Действия: ${model.label}`;
  return (
    <MenuAnchor>
      <IconButton icon="dots" label={label} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} />
      <Menu open={open} onClose={() => setOpen(false)} label={label} width={220} floating>
        <MenuItem icon="edit" onSelect={() => (setOpen(false), onEdit())}>
          Изменить
        </MenuItem>
        {model.connection === 'api_key' ? (
          <MenuItem icon="key" onSelect={() => (setOpen(false), onKeys())}>
            Ключи
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuItem
          icon="trash"
          danger
          onSelect={() => {
            setOpen(false);
            void confirm({ title: `Удалить модель «${model.label}»?`, text: 'Её ключи удалятся, расходы в отчётах останутся.', confirmLabel: 'Удалить', danger: true }).then(async (yes) => {
              if (yes && (await run(() => adminApi.deleteModel(model.id), 'Модель удалена'))) onChanged();
            });
          }}
        >
          Удалить
        </MenuItem>
      </Menu>
      <Feedback error={error} />
    </MenuAnchor>
  );
}

function Catalog({ data, onChanged }: { data: ModelsResponse; onChanged: () => void }) {
  const wide = useMedia(WIDE_QUERY);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ModelDto | null>(null);
  const [keysOf, setKeysOf] = useState<string | null>(null);
  const { error, run } = useAction();
  const keysModel = data.models.find((m) => m.id === keysOf) ?? null;
  const toggle = async (m: ModelDto, enabled: boolean) => {
    if (await run(() => adminApi.updateModel(m.id, { enabled }), enabled ? 'Модель включена' : 'Модель выключена')) onChanged();
  };
  return (
    <Card className={`${section.tableCard} rise`}>
      <div className={styles.catalogHead}>
        <h2 className={styles.cardTitle}>Каталог моделей</h2>
        <Button icon="plus" onClick={() => setAdding(true)}>
          Добавить модель
        </Button>
      </div>
      <div className={styles.inset}>
        <Feedback error={error} />
      </div>
      {data.models.length === 0 ? (
        <EmptyState title="Моделей пока нет" text="Добавьте первую: без модели агенты не отвечают." />
      ) : !wide ? (
        <ul className={styles.phoneList} aria-label="Каталог моделей">
          {data.models.map((m) => {
            const r = role(m, data.settings);
            return (
              <li key={m.id} className={styles.phoneRow}>
                <div className={styles.phoneMain}>
                  <div className={styles.modelName}>{m.label}</div>
                  <div className={section.sub}>{connection(m, data.accounts)}</div>
                  {m.apiBase ? <div className={cx(styles.mono, styles.address)}>{m.apiBase}</div> : null}
                </div>
                {r ? <Pill tone={r.tone}>{r.text}</Pill> : null}
                <Switch size="lg" checked={m.enabled} label={m.label} onChange={(on) => void toggle(m, on)} />
                <RowMenu model={m} onEdit={() => setEditing(m)} onKeys={() => setKeysOf(m.id)} onChanged={onChanged} />
              </li>
            );
          })}
        </ul>
      ) : (
        <Table minWidth={760} label="Каталог моделей">
          <thead>
            <tr>
              <th scope="col">Модель</th>
              <th scope="col">Подключение</th>
              <th scope="col" className={numCell}>
                Вход, ₽ за 1 млн
              </th>
              <th scope="col" className={numCell}>
                Выход, ₽ за 1 млн
              </th>
              <th scope="col">Роль</th>
              <th scope="col">Включена</th>
              <th scope="col">
                <span className="visually-hidden">Действия</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((m) => {
              const r = role(m, data.settings);
              return (
                <tr key={m.id}>
                  <td>
                    <div className={styles.modelName}>
                      {m.label}
                      {m.kind === 'transcription' ? <span className={section.sub}> · речь</span> : null}
                      {m.vision ? <span className={section.sub}> · видит картинки</span> : null}
                    </div>
                    <div className={styles.mono}>{m.providerModel}</div>
                    {m.apiBase ? <div className={cx(styles.mono, styles.address)}>{m.apiBase}</div> : null}
                  </td>
                  <td className={styles.muted}>{connection(m, data.accounts)}</td>
                  <td className={cx(numCell, styles.mono)}>{m.pricePerMinute !== null ? `${money(m.pricePerMinute)} за мин` : m.prices ? money(m.prices.input) : '0'}</td>
                  <td className={cx(numCell, styles.mono)}>{m.pricePerMinute !== null ? '—' : m.prices ? money(m.prices.output) : '0'}</td>
                  <td>{r ? <Pill tone={r.tone}>{r.text}</Pill> : null}</td>
                  <td>
                    <Switch checked={m.enabled} label={m.label} onChange={(on) => void toggle(m, on)} />
                  </td>
                  <td className={section.actionsCell}>
                    <RowMenu model={m} onEdit={() => setEditing(m)} onKeys={() => setKeysOf(m.id)} onChanged={onChanged} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <div className={styles.foot}>Цены в рублях переносятся в учёт шлюза, поэтому лимиты и расходы сразу в рублях. У подписки цена 0: токены считаются, деньги нет.</div>
      {adding ? (
        <ModelForm
          model={null}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            onChanged();
          }}
        />
      ) : null}
      {editing ? (
        <ModelForm
          model={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      ) : null}
      {keysModel ? <KeysList model={keysModel} onClose={() => setKeysOf(null)} onChanged={onChanged} /> : null}
    </Card>
  );
}

export function ModelsSection() {
  // A form starts from what it loads: loaded anew at every opening, never from memory (spec, section 8.22).
  const { state, reload } = useLoad(adminApi.models);
  const lead = 'Модели, их ключи и цены, правила обращения к ним. Все запросы идут через шлюз LiteLLM: учёт и лимиты в рублях.';
  if (state.status === 'loading') return <div className={section.stack}><PageHead title="Нейросеть" lead={lead} /><DelayedBar /></div>;
  if (state.status === 'error') return <div className={section.stack}><PageHead title="Нейросеть" lead={lead} /><ErrorBanner error={state.error} onRetry={reload} /></div>;
  const data = state.data;
  return (
    <div className={section.stack}>
      <PageHead title="Нейросеть" lead={lead} />
      {/* Between the lead and the catalog (owner's list 16.11): the state of the gateway the catalog goes to. */}
      <div className={styles.gatewayRow}>
        <Gateway gateway={data.gateway} />
      </div>
      <Catalog data={data} onChanged={reload} />
      <div className={styles.columns}>
        <AccountsPool accounts={data.accounts} onChanged={reload} />
        <ModelParams key={JSON.stringify(data.settings)} models={data.models} settings={data.settings} onSaved={reload} />
      </div>
    </div>
  );
}
