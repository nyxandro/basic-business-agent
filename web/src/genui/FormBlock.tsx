// Form (spec, section 7): errors stay next to the field; the answers leave as an ordinary message.
import type { FormBlock } from '@bba/contracts';
import { useId, useState, type SubmitEvent } from 'react';
import { ru } from '../i18n/ru.ts';

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
    <form className="genui genui-form" onSubmit={submit} noValidate>
      <p className="genui-form-title">{block.title}</p>
      {block.fields.map((f, i) => {
        const id = `${formId}-${i}`;
        const problem = problems[f.name];
        const set = (v: string) => setValues((prev) => ({ ...prev, [f.name]: v }));
        const common = { id, disabled: answered, 'aria-invalid': problem ? true : undefined, 'aria-describedby': problem ? `${id}-error` : undefined };
        return (
          <div key={f.name} className="genui-form-field">
            <label htmlFor={id}>{f.label}</label>
            {f.kind === 'select' ? (
              <select {...common} value={values[f.name] ?? ''} onChange={(e) => set(e.target.value)}>
                <option value="">{ru.genui.choose}</option>
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input {...common} type={f.kind === 'number' ? 'text' : f.kind} inputMode={f.kind === 'number' ? 'decimal' : undefined} value={values[f.name] ?? ''} onChange={(e) => set(e.target.value)} />
            )}
            {problem ? (
              <span id={`${id}-error`} className="field-error">
                {problem}
              </span>
            ) : null}
          </div>
        );
      })}
      <button type="submit" className="btn" disabled={answered}>
        {block.submitLabel}
      </button>
    </form>
  );
}
