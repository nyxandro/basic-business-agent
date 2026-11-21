// The address and the way of sign-in of an MCP server (docs/specs/[20.11.2026]-mcp-connections.md, scenario 1 and 1a):
// what the form keeps, and its parts — the four ways of sign-in, the fields of a key and where it goes (a header or
// the address), the values of the shared key, the app of the installation for a sign-in on the system's site.
import { MCP_AUTH_KINDS, MCP_OAUTH_CALLBACK_PATH, type McpAuthKind, type McpField, type McpServerInput, type McpServerView } from '@bba/contracts';
import { useId, useState } from 'react';
import { ru } from '../i18n/ru.ts';
import { Button, IconButton } from '../ui/Button.tsx';
import { Collapse } from '../ui/Collapse.tsx';
import { Field, Input } from '../ui/Field.tsx';
import section from './section.module.css';
import styles from './mcp.module.css';

const t = ru.mcp.admin;
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;

export interface McpForm {
  title: string;
  url: string;
  auth: McpAuthKind;
  fields: McpField[];
  headers: { name: string; value: string }[];
  // Typed values of the shared key; empty — the saved ones stay (a draft being edited).
  shared: Record<string, string>;
  clientId: string;
  clientSecret: string;
}

export const placeholdersOf = (url: string) => [...new Set([...url.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
export const keyed = (auth: McpAuthKind) => auth === 'personal_key' || auth === 'shared_key';

export function formOf(server: McpServerView | null): McpForm {
  return {
    title: server?.title ?? '',
    url: server?.url ?? '',
    auth: server?.auth ?? 'none',
    fields: server?.fields ?? [],
    headers: Object.entries(server?.headers ?? {}).map(([name, value]) => ({ name, value })),
    shared: {},
    clientId: server?.clientId ?? '',
    clientSecret: '',
  };
}

// A key goes into the address when the address has {{…}}; otherwise — as a bearer token by default.
export function withKeyDefaults(form: McpForm): McpForm {
  if (!keyed(form.auth) || form.fields.length > 0) return form;
  const inUrl = placeholdersOf(form.url);
  if (inUrl.length > 0) return { ...form, fields: inUrl.map((key) => ({ key, label: key === 'token' ? 'Ключ API' : key, hint: '', secret: true })) };
  return { ...form, fields: [{ key: 'token', label: 'Ключ API', hint: '', secret: true }], headers: [{ name: 'Authorization', value: 'Bearer {{token}}' }] };
}

export function inputOf(form: McpForm, creating: boolean): McpServerInput {
  const withKey = keyed(form.auth);
  const typed = form.fields.every((f) => form.shared[f.key]);
  return {
    title: form.title.trim(),
    transport: 'http',
    url: form.url.trim(),
    program: null,
    auth: form.auth,
    fields: withKey ? form.fields : [],
    headers: withKey ? Object.fromEntries(form.headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value])) : {},
    env: {},
    // A draft keeps its saved shared key unless all of it is typed again (the browser never gets it back).
    sharedValues: form.auth === 'shared_key' && (creating || typed) ? Object.fromEntries(form.fields.map((f) => [f.key, form.shared[f.key] ?? ''])) : null,
    client: form.auth === 'oauth' && form.clientId.trim() ? { clientId: form.clientId.trim(), ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}) } : null,
  };
}

function FieldsEditor({ form, onChange }: { form: McpForm; onChange: (next: McpForm) => void }) {
  const set = (i: number, patch: Partial<McpField>) => onChange({ ...form, fields: form.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  return (
    <fieldset className={styles.group}>
      <legend className={styles.legend}>{t.fieldsLegend}</legend>
      {form.fields.map((field, i) => (
        <div key={i} className={styles.fieldRow}>
          <Field label={t.fieldKey}>
            <Input mono required value={field.key} onChange={(e) => set(i, { key: e.target.value })} />
          </Field>
          <Field label={t.fieldLabel}>
            <Input required value={field.label} onChange={(e) => set(i, { label: e.target.value })} />
          </Field>
          <Field label={t.fieldHint}>
            <Input value={field.hint} onChange={(e) => set(i, { hint: e.target.value })} />
          </Field>
          <label className={styles.inlineCheck}>
            <input type="checkbox" checked={field.secret} onChange={(e) => set(i, { secret: e.target.checked })} />
            {t.fieldSecret}
          </label>
          <IconButton icon="trash" label={t.removeField(field.label || field.key)} onClick={() => onChange({ ...form, fields: form.fields.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <Button size="sm" icon="plus" onClick={() => onChange({ ...form, fields: [...form.fields, { key: '', label: '', hint: '', secret: true }] })}>
        {t.addField}
      </Button>
    </fieldset>
  );
}

function HeadersEditor({ form, onChange }: { form: McpForm; onChange: (next: McpForm) => void }) {
  const set = (i: number, patch: Partial<McpForm['headers'][number]>) => onChange({ ...form, headers: form.headers.map((h, j) => (j === i ? { ...h, ...patch } : h)) });
  return (
    <fieldset className={styles.group}>
      <legend className={styles.legend}>{t.headersLegend}</legend>
      <p className={section.sub}>{t.headersHint}</p>
      {form.headers.map((header, i) => (
        <div key={i} className={styles.headerRow}>
          <Field label={t.headerName}>
            <Input mono value={header.name} onChange={(e) => set(i, { name: e.target.value })} />
          </Field>
          <Field label={t.headerValue}>
            <Input mono value={header.value} onChange={(e) => set(i, { value: e.target.value })} />
          </Field>
          <IconButton icon="trash" label={t.removeHeader(header.name)} onClick={() => onChange({ ...form, headers: form.headers.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <Button size="sm" icon="plus" onClick={() => onChange({ ...form, headers: [...form.headers, { name: '', value: '' }] })}>
        {t.addHeader}
      </Button>
    </fieldset>
  );
}

// The return address the admin gives the system with the app: «Скопировать».
function RedirectAddress() {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}${MCP_OAUTH_CALLBACK_PATH}`;
  const copy = () =>
    navigator.clipboard.writeText(link).then(
      () => setCopied(true),
      // Without clipboard access the address stays selectable in the field.
      (error: unknown) => console.warn('clipboard is not available', error),
    );
  return (
    <div className={styles.group}>
      <label className={styles.legend} htmlFor={id}>
        {t.redirect}
      </label>
      <div className={styles.copyRow}>
        <Input id={id} mono readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        <Button size="sm" icon="copy" onClick={() => void copy()}>
          {copied ? t.copied : t.copy}
        </Button>
      </div>
    </div>
  );
}

export function AccessFields({ form, onChange, server }: { form: McpForm; onChange: (next: McpForm) => void; server: McpServerView | null }) {
  const [advanced, setAdvanced] = useState(Boolean(server?.clientId));
  const name = useId();
  const choose = (auth: McpAuthKind) => onChange(withKeyDefaults({ ...form, auth }));
  return (
    <>
      <fieldset className={styles.group}>
        <legend className={styles.legend}>{t.authLegend}</legend>
        <div className={styles.radios}>
          {MCP_AUTH_KINDS.map((kind) => (
            <label key={kind} className={styles.radio}>
              <input type="radio" name={name} checked={form.auth === kind} onChange={() => choose(kind)} />
              {t.authKinds[kind]}
            </label>
          ))}
        </div>
      </fieldset>
      {form.auth === 'shared_key' ? <p className={section.note}>{t.sharedWarning}</p> : null}
      {keyed(form.auth) ? (
        <>
          <FieldsEditor form={form} onChange={onChange} />
          <HeadersEditor form={form} onChange={onChange} />
        </>
      ) : null}
      {form.auth === 'shared_key'
        ? form.fields.map((field) => (
            <Field key={field.key} label={t.sharedValue(field.label || field.key)} hint={server?.sharedConfigured ? t.sharedKept : field.hint || undefined}>
              <Input type="password" autoComplete="new-password" required={!server?.sharedConfigured} value={form.shared[field.key] ?? ''} onChange={(e) => onChange({ ...form, shared: { ...form.shared, [field.key]: e.target.value } })} />
            </Field>
          ))
        : null}
      {form.auth === 'oauth' ? (
        <div className={styles.group}>
          <Button size="sm" variant="ghost" aria-expanded={advanced} onClick={() => setAdvanced((open) => !open)}>
            {t.advanced}
          </Button>
          <Collapse open={advanced}>
            <div className={styles.advanced}>
              <p className={section.sub}>{t.advancedLead}</p>
              <RedirectAddress />
              <div className={section.row}>
                <Field label={t.clientId}>
                  <Input mono autoComplete="off" value={form.clientId} onChange={(e) => onChange({ ...form, clientId: e.target.value })} />
                </Field>
                <Field label={t.clientSecret} hint={server?.clientSecretSet ? t.clientSecretKept : undefined}>
                  <Input type="password" autoComplete="new-password" value={form.clientSecret} onChange={(e) => onChange({ ...form, clientSecret: e.target.value })} />
                </Field>
              </div>
            </div>
          </Collapse>
        </div>
      ) : null}
    </>
  );
}
