// «Согласования» (docs/specs/[20.11.2026]-multi-step-approvals.md, scenario 1): the rules — an action of agents and the
// stages of approvers in order; a stage is «руководитель отдела сотрудника» and named people, any of whom decides. The
// rule is on the action as a whole (owner 21.11, F2): the form advises a narrow action.
import type { AdminPerson, ApprovalRuleDto, ApprovalRuleInput, ApprovalRulesResponse, RuleApprover } from '@bba/contracts';
import { RULE_STAGES_MAX } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { Button, IconButton } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, EmptyState, PageHead } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Select } from '../ui/Field.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { Modal } from '../ui/Modal.tsx';
import { Switch } from '../ui/Switch.tsx';
import { useLoad } from '../ui/use-load.ts';
import { api } from '../api/client.ts';
import { adminApi } from './api.ts';
import models from './models.module.css';
import chips from '../ui/chips.module.css';
import { Feedback, useAction } from '../ui/form-parts.tsx';
import section from './section.module.css';
import styles from './tasks.module.css';

const R = '/app/api/admin/approval-rules';
const rulesApi = {
  list: () => api<ApprovalRulesResponse>('GET', R),
  save: (id: string | null, input: ApprovalRuleInput) => (id ? api<ApprovalRuleDto>('PUT', `${R}/${encodeURIComponent(id)}`, input) : api<ApprovalRuleDto>('POST', R, input)),
  remove: (id: string) => api<{ ok: true }>('DELETE', `${R}/${encodeURIComponent(id)}`),
};

const HEAD = 'Руководитель отдела сотрудника';

function stageText(stage: RuleApprover[], people: AdminPerson[]): string {
  return stage.map((a) => (a.kind === 'head' ? HEAD : (people.find((p) => p.id === a.userId)?.name ?? 'сотрудник удалён'))).join(' или ');
}

function RuleForm({ rule, actions, people, onClose, onSaved }: { rule: ApprovalRuleDto | null; actions: ApprovalRulesResponse['actions']; people: AdminPerson[]; onClose: () => void; onSaved: () => void }) {
  const [target, setTarget] = useState(rule?.target ?? actions[0]?.target ?? '');
  const [stages, setStages] = useState<RuleApprover[][]>(rule?.stages ?? [[{ kind: 'head' }]]);
  const { busy, error, run } = useAction();
  const setStage = (i: number, next: RuleApprover[]) => setStages((all) => all.map((s, n) => (n === i ? next : s)));
  async function save() {
    if (await run(() => rulesApi.save(rule?.id ?? null, { target, stages, enabled: rule?.enabled ?? true }), 'Правило сохранено')) onSaved();
  }
  return (
    <Modal open onClose={onClose} label={rule ? 'Правило согласования' : 'Новое правило'}>
      <form
        className={section.form}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 className={section.formTitle}>{rule ? 'Правило согласования' : 'Новое правило'}</h2>
        <Feedback error={error} />
        <Field label="Действие" hint="Правило сработает на каждый вызов этого действия. Если у системы есть более узкое действие (например, «Изменить скидку»), выберите его.">
          <Select required value={target} onChange={(e) => setTarget(e.target.value)}>
            {actions.map((a) => (
              <option key={a.target} value={a.target}>
                {a.system ? `${a.system} · ${a.title}` : a.title}
              </option>
            ))}
          </Select>
        </Field>
        <fieldset className={models.prices}>
          <legend className={models.legend}>Этапы</legend>
          {stages.map((stage, i) => (
            <div key={i} className={styles.stage}>
              <div className={styles.stageHead}>
                <span>Этап {i + 1}</span>
                {stages.length > 1 ? <IconButton icon="trash" size="sm" label={`Убрать этап ${i + 1}`} onClick={() => setStages((all) => all.filter((_, n) => n !== i))} /> : null}
              </div>
              <label className={styles.stageHeadRow}>
                <input type="checkbox" checked={stage.some((a) => a.kind === 'head')} onChange={(e) => setStage(i, e.target.checked ? [{ kind: 'head' }, ...stage] : stage.filter((a) => a.kind !== 'head'))} />
                {HEAD}
              </label>
              <Select aria-label={`Сотрудник этапа ${i + 1}`} value="" onChange={(e) => e.target.value && setStage(i, [...stage, { kind: 'user', userId: e.target.value }])}>
                <option value="">Добавить сотрудника…</option>
                {people
                  .filter((p) => !stage.some((a) => a.kind === 'user' && a.userId === p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
              <p className={section.note}>{stage.length > 0 ? `Согласует: ${stageText(stage, people)}` : 'Укажите хотя бы одного согласующего.'}</p>
              {stage.some((a) => a.kind === 'user') ? (
                <div className={chips.row}>
                  {stage.flatMap((a) =>
                    a.kind === 'user'
                      ? [
                          <button key={a.userId} type="button" className={chips.chip} onClick={() => setStage(i, stage.filter((x) => !(x.kind === 'user' && x.userId === a.userId)))}>
                            {people.find((p) => p.id === a.userId)?.name ?? 'сотрудник удалён'} ×
                          </button>,
                        ]
                      : [],
                  )}
                </div>
              ) : null}
            </div>
          ))}
          {stages.length < RULE_STAGES_MAX ? (
            <Button icon="plus" onClick={() => setStages((all) => [...all, [{ kind: 'head' }]])}>
              Добавить этап
            </Button>
          ) : null}
        </fieldset>
        <div className={section.formActions}>
          <Button onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" disabled={busy || !target || stages.some((s) => s.length === 0)}>
            Сохранить
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ApprovalRules() {
  const load = useCallback(async () => {
    const [rules, people] = await Promise.all([rulesApi.list(), adminApi.people()]);
    return { ...rules, people: people.people };
  }, []);
  const { state, reload } = useLoad(load, ['admin', 'approval-rules']);
  const [editing, setEditing] = useState<ApprovalRuleDto | 'new' | null>(null);
  const confirm = useConfirm();
  const { error, run } = useAction();
  const head = <PageHead title="Согласования" lead="Выбранные действия агентов выполняются только после «Да» сотрудника и согласия каждого этапа: руководителя отдела, названных сотрудников." />;
  if (state.status === 'loading') return <div className={section.stack}>{head}<DelayedBar /></div>;
  if (state.status === 'error') return <div className={section.stack}>{head}<ErrorBanner error={state.error} onRetry={reload} /></div>;
  const { rules, actions, people } = state.data;
  return (
    <div className={section.stack}>
      {head}
      <Card className={`${section.tableCard} rise`}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>Правила</h2>
          <Button variant="primary" icon="plus" disabled={actions.length === 0} onClick={() => setEditing('new')}>
            Новое правило
          </Button>
        </div>
        <div className={styles.inset}>
          <Feedback error={error} />
        </div>
        {rules.length === 0 ? (
          <EmptyState title="Правил пока нет" text="Добавьте правило — и выбранные действия агентов будут выполняться только после согласования." />
        ) : (
          <ul className={styles.phoneList} aria-label="Правила согласования">
            {rules.map((r) => (
              <li key={r.id} className={styles.phoneTask}>
                <div className={styles.phoneMain}>
                  <div className={styles.taskName}>{r.title ?? `${r.target} — действия сейчас нет ни у одного агента`}</div>
                  <div className={section.sub}>{r.stages.map((s, i) => `${i + 1}: ${stageText(s, people)}`).join(' → ')}</div>
                </div>
                <Switch checked={r.enabled} label={r.title ?? r.target} onChange={(on) => void run(() => rulesApi.save(r.id, { target: r.target, stages: r.stages, enabled: on }), on ? 'Правило включено' : 'Правило выключено').then((ok) => ok && reload())} />
                <IconButton icon="edit" label={`Изменить: ${r.title ?? r.target}`} onClick={() => setEditing(r)} />
                <IconButton
                  icon="trash"
                  label={`Удалить: ${r.title ?? r.target}`}
                  onClick={() =>
                    void confirm({ title: 'Удалить правило?', text: 'Заявки, которые уже ждут согласования, дойдут до конца по своим этапам.', confirmLabel: 'Удалить', danger: true }).then(async (yes) => {
                      if (yes && (await run(() => rulesApi.remove(r.id), 'Правило удалено'))) reload();
                    })
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing ? (
        <RuleForm
          rule={editing === 'new' ? null : editing}
          actions={actions}
          people={people}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}
