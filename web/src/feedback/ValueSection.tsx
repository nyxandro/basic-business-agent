// «Польза от агентов» (docs/specs/[20.11.2026]-feedback-and-value.md, scenario 5; owner 21.11, F2), with «Расходы»: what
// the agents did in the months chosen and the hours of work it stands for by the norms, beside the spend on models; by
// departments (under 3 people — together) and by agents; «Как посчитано» with the norms the admin changes; «Скачать
// отчёт» — a file for Excel.
import { WORK_KINDS, type ValueCounts, type ValueReport, type WorkKind } from '@bba/contracts';
import { useCallback, useState } from 'react';
import { Feedback, useAction } from '../ui/form-parts.tsx';
import { ru } from '../i18n/ru.ts';
import { Button, ButtonLink } from '../ui/Button.tsx';
import { Card, EmptyState, PageHead } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { fullDate, rub } from '../i18n/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import { saveNorms, valueCsvUrl, valueReport } from './api.ts';
import styles from './feedback.module.css';

const t = ru.feedback.value;
const hours = (minutes: number) => (Math.round((minutes / 60) * 10) / 10).toLocaleString('ru-RU');
const thisMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

function Breakdown({ title, rows, hint }: { title: string; rows: ({ id: string; name: string } & ValueCounts)[]; hint?: string }) {
  if (rows.length === 0) return null;
  return (
    <Card className="rise">
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {hint ? <p className={styles.note}>{hint}</p> : null}
        <div className={styles.tableWrap}>
          <table className={styles.table} aria-label={title}>
            <thead>
              <tr>
                <th scope="col">{title}</th>
                <th scope="col">{t.people}</th>
                <th scope="col">{t.conversations}</th>
                {WORK_KINDS.map((k) => (
                  <th key={k} scope="col">
                    {t.kinds[k]}
                  </th>
                ))}
                <th scope="col">{t.hoursColumn}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.name}</th>
                  <td>{r.people}</td>
                  <td>{r.conversations}</td>
                  {WORK_KINDS.map((k) => (
                    <td key={k}>{r.facts[k]}</td>
                  ))}
                  <td>{hours(r.minutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

function Norms({ report, onSaved }: { report: ValueReport; onSaved: () => void }) {
  const [norms, setNorms] = useState<Record<WorkKind, string>>(() => Object.fromEntries(WORK_KINDS.map((k) => [k, String(report.norms[k])])) as Record<WorkKind, string>);
  const [hourRub, setHourRub] = useState(report.hourRub === null ? '' : String(report.hourRub));
  const { busy, error, run } = useAction();
  const valid = WORK_KINDS.every((k) => /^\d{1,3}$/.test(norms[k]) && Number(norms[k]) <= 600) && (hourRub === '' || Number(hourRub) > 0);
  return (
    <form
      className={styles.section}
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = Object.fromEntries(WORK_KINDS.map((k) => [k, Number(norms[k])])) as Record<WorkKind, number>;
        void run(() => saveNorms(parsed, hourRub === '' ? null : Number(hourRub)), t.normsSaved).then((ok) => ok && onSaved());
      }}
    >
      <h2 className={styles.sectionTitle}>{t.how}</h2>
      <p className={styles.note}>{t.disclaimer}</p>
      <h3 className={styles.sectionTitle}>{t.norms}</h3>
      <div className={styles.normsGrid}>
        {WORK_KINDS.map((k) => (
          <Field key={k} label={t.kinds[k]}>
            <Input inputMode="numeric" value={norms[k]} onChange={(e) => setNorms((all) => ({ ...all, [k]: e.target.value.trim() }))} />
          </Field>
        ))}
      </div>
      <Field label={t.hourRub} hint={t.hourRubHint}>
        <Input inputMode="decimal" value={hourRub} onChange={(e) => setHourRub(e.target.value.trim().replace(',', '.'))} />
      </Field>
      <Feedback error={error} />
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {t.saveNorms}
        </Button>
      </div>
    </form>
  );
}

function Report({ report, onNorms }: { report: ValueReport; onNorms: () => void }) {
  const total = report.total;
  const did = total.people > 0 || WORK_KINDS.some((k) => total.facts[k] > 0);
  return (
    <>
      <p className={styles.note}>{t.since(fullDate(report.factsSince))}</p>
      <Card className="rise">
        <div className={styles.summary}>
          <div>
            <div className={styles.big}>{t.hours(hours(total.minutes))}</div>
            {report.hourRub !== null ? <div className={styles.note}>{t.money(rub((total.minutes / 60) * report.hourRub))}</div> : null}
          </div>
          <div>
            <div className={styles.big}>{t.spend(rub(report.spendRub))}</div>
            {report.subscriptionCalls > 0 ? <div className={styles.note}>{t.subscription(report.subscriptionCalls)}</div> : null}
          </div>
        </div>
        {did ? (
          <div className={styles.tableWrap}>
            <table className={styles.table} aria-label={t.period}>
              <tbody>
                <tr>
                  <th scope="row">{t.people}</th>
                  <td>{total.people}</td>
                </tr>
                <tr>
                  <th scope="row">{t.conversations}</th>
                  <td>{total.conversations}</td>
                </tr>
                {WORK_KINDS.map((k) => (
                  <tr key={k}>
                    <th scope="row">{t.kinds[k]}</th>
                    <td>{total.facts[k]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title={t.empty} />
        )}
      </Card>
      <Breakdown title={t.departments} rows={[...report.departments, ...(report.otherDepartments ? [{ id: 'other', name: t.other, ...report.otherDepartments }] : [])]} {...(report.otherDepartments ? { hint: t.otherHint } : {})} />
      <Breakdown title={t.agents} rows={[...report.agents, ...(report.otherAgents ? [{ id: 'other', name: t.otherAgents, ...report.otherAgents }] : [])]} />
      {report.hidden ? <p className={styles.note}>{t.hiddenNote}</p> : null}
      <Card className="rise">
        <Norms key={JSON.stringify([report.norms, report.hourRub])} report={report} onSaved={onNorms} />
      </Card>
    </>
  );
}

export function ValueSection() {
  const [from, setFrom] = useState(thisMonth);
  const [to, setTo] = useState(thisMonth);
  const load = useCallback(() => valueReport(from, to), [from, to]);
  const { state, reload } = useLoad(load);
  return (
    <div className={styles.stack}>
      <PageHead title={t.title} lead={t.lead} actions={<ButtonLink href={valueCsvUrl(from, to)} download icon="download">{t.download}</ButtonLink>} />
      <div className={styles.months}>
        <Field label={t.from}>
          <Input type="month" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </Field>
        <Field label={t.to}>
          <Input type="month" value={to} min={from} max={thisMonth()} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </Field>
      </div>
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? <Report report={state.data} onNorms={reload} /> : null}
    </div>
  );
}
