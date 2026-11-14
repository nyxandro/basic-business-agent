// Form (spec, section 7): errors stay next to the field; the answers leave as an ordinary message.
import type { FormBlock } from '@bba/contracts';
import { useId, useState, type SubmitEvent } from 'react';
import { ru } from '../i18n/ru.ts';
import { Button } from '../ui/Button.tsx';
import { Field, Input, Select } from '../ui/Field.tsx';
import styles from './genui.module.css';

type Field = FormBlock['fields'][number];

function problemOf(field: Field, value: string): string | null {
  if (field.required && !value.trim()) return ru.genui.required;
  if (field.kind === 'number' && value.trim() && !Number.isFinite(Number(value.replace(',', '.')))) return ru.genui.notNumber;
  return null;
}

export function answerText(block: FormBlock, values: Record<string, string>): string {
  const lines = block.fields.map((f) => `- ${f.label}: ${values[f.name]?.trim() || '—'}`);
  return [`${block.title}:`, ...lines].join('\n');
}

export function FormBlockView({ block, answered, onAnswer }: { block: FormBlock; answered: boolean; onAnswer: (text: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const formId = useId();

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const found = Object.fromEntries(block.fields.map((f) => [f.name, problemOf(f, values[f.name] ?? '')]).filter((e): e is [string, string] => e[1] !== null));
    setProblems(found);
    if (Object.keys(found).length === 0) onAnswer(answerText(block, values));
  }

  return (
    <form className={`${styles.block} ${styles.form}`} onSubmit={submit} noValidate>
      <p className={styles.formTitle}>{block.title}</p>
      {block.fields.map((f, i) => {
        const id = `${formId}-${i}`;
        const problem = problems[f.name];
        const set = (v: string) => setValues((prev) => ({ ...prev, [f.name]: v }));
        const common = { id, disabled: answered, 'aria-invalid': problem ? true : undefined };
        return (
          <Field key={f.name} label={f.label} error={problem ?? null}>
            {f.kind === 'select' ? (
              <Select {...common} value={values[f.name] ?? ''} onChange={(e) => set(e.target.value)}>
                <option value="">{ru.genui.choose}</option>
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            ) : (
              <Input {...common} type={f.kind === 'number' ? 'text' : f.kind} inputMode={f.kind === 'number' ? 'decimal' : undefined} value={values[f.name] ?? ''} onChange={(e) => set(e.target.value)} />
            )}
          </Field>
        );
      })}
      <div className={styles.formActions}>
        <Button type="submit" variant="primary" disabled={answered}>
          {block.submitLabel}
        </Button>
      </div>
    </form>
  );
}
