// The window «Сервер MCP» (docs/specs/[20.11.2026]-mcp-connections.md, scenario 1, 1a and 5): the address — the server
// tells how it lets people in; the way of sign-in and the keys — saved as a draft; «Проверить своим доступом» — the
// list of actions; the actions and the agents — «Включить». A server with a sign-in on the system's site sends the
// admin there first and comes back to this window (ConnectionsSection opens it again with `autoCheck`).
import { MCP_TRANSPORTS, type McpProbeAuth, type McpServerView, type McpTransport } from '@bba/contracts';
import { useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import { asApiError, type ApiRequestError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button, IconButton } from '../ui/Button.tsx';
import { Pill } from '../ui/Display.tsx';
import { Feedback, useAction } from '../ui/form-parts.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { Modal } from '../ui/Modal.tsx';
import { useLoad } from '../ui/use-load.ts';
import { AccessFields, formOf, inputOf, keyed, placeholdersOf, ProgramFields, withKeyDefaults, type McpForm } from './McpAccessForm.tsx';
import { ActionsEditor, marksOf, type Mark } from './McpActions.tsx';
import { adminApi } from './api.ts';
import section from './section.module.css';
import styles from './mcp.module.css';

const t = ru.mcp.admin;
const NOT_SIGNED_IN = 'APP_CONNECTOR_NOT_CONNECTED';
const PROBED_AUTH: Record<McpProbeAuth, McpForm['auth']> = { none: 'none', oauth: 'oauth', key: 'personal_key' };

type Step = 'setup' | 'check' | 'actions';

const firstStep = (server: McpServerView | null): Step => (!server ? 'setup' : server.snapshotAt ? 'actions' : 'check');

function Setup({ server, onSaved }: { server: McpServerView | null; onSaved: (next: McpServerView) => void }) {
  const [form, setForm] = useState<McpForm>(() => formOf(server));
  // A new server shows the way of sign-in after «Далее»: the address tells it first.
  const [probed, setProbed] = useState<McpProbeAuth | null>(server ? probedOf(server) : null);
  const { busy, error, run } = useAction();
  const transportName = useId();
  const program = form.transport === 'program';
  // A program has no address to look at: its way of sign-in is chosen right away (none or the shared key).
  const chooseTransport = (transport: McpTransport) => {
    setForm({ ...form, transport, auth: 'none', fields: [], headers: [], env: [] });
    setProbed(transport === 'program' ? 'none' : null);
  };

  function next() {
    void run(async () => {
      // An address with {{…}} answers only with a value: the fields are described first, the check uses them.
      if (placeholdersOf(form.url).length > 0) {
        setForm((f) => withKeyDefaults({ ...f, auth: 'personal_key' }));
        setProbed('key');
        return;
      }
      const result = await adminApi.probeMcp({ url: form.url.trim(), fields: [], values: {} });
      setForm((f) => withKeyDefaults({ ...f, auth: PROBED_AUTH[result.auth] }));
      setProbed(result.auth);
    }, null);
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    if (!probed) return next();
    void run(async () => {
      const input = inputOf(form, !server);
      onSaved(server ? (await adminApi.updateMcp(server.id, { definition: input })).server : (await adminApi.createMcp(input)).server);
    }, null);
  }

  return (
    <form className={section.form} onSubmit={save}>
      <p className={section.sub}>{t.draftLead}</p>
      <div className={section.row}>
        <Field label={t.title} hint={t.titleHint}>
          <Input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Битрикс24" />
        </Field>
      </div>
      <fieldset className={styles.group}>
        <legend className={styles.legend}>{t.transportLegend}</legend>
        <div className={styles.radios}>
          {MCP_TRANSPORTS.map((transport) => (
            <label key={transport} className={styles.radio}>
              <input type="radio" name={transportName} checked={form.transport === transport} onChange={() => chooseTransport(transport)} />
              {t.transports[transport]}
            </label>
          ))}
        </div>
      </fieldset>
      {program ? (
        <ProgramFields form={form} onChange={setForm} />
      ) : (
        <Field label={t.url} hint={t.urlHint}>
          <Input
            mono
            required
            value={form.url}
            onChange={(e) => {
              setForm({ ...form, url: e.target.value });
              if (!server) setProbed(null);
            }}
            placeholder="https://mcp.example.com/mcp"
          />
        </Field>
      )}
      {probed ? (
        <>
          {server || program ? null : <p className={styles.probed}>{t.probed[probed]}</p>}
          <AccessFields form={form} onChange={setForm} server={server} />
        </>
      ) : null}
      <Feedback error={error} />
      <div className={section.formActions}>
        <Button type="submit" variant="primary" disabled={busy}>
          {!probed ? (busy ? t.probing : t.next) : t.saveDraft}
        </Button>
      </div>
    </form>
  );
}

// An edited draft shows its way of sign-in at once: the address was looked at when it was added.
function probedOf(server: McpServerView): McpProbeAuth {
  return server.auth === 'oauth' ? 'oauth' : keyed(server.auth) ? 'key' : 'none';
}

function Check({ server, autoCheck, onChecked }: { server: McpServerView; autoCheck: boolean; onChecked: (next: McpServerView) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      onChecked((await adminApi.checkMcp(server.id, server.auth === 'personal_key' ? values : {})).server);
    } catch (raw) {
      const failure = asApiError(raw);
      // The admin has not signed in to the system yet: the system's site, then back to this window.
      if (failure.code === NOT_SIGNED_IN && server.auth === 'oauth') {
        try {
          window.location.assign((await adminApi.signInMcp(server.id)).url);
          return;
        } catch (signIn) {
          setError(asApiError(signIn));
        }
      } else {
        setError(failure);
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!autoCheck || started.current) return;
    started.current = true;
    void check();
    // Once, right after the sign-in on the system's site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheck]);

  return (
    <form
      className={section.form}
      onSubmit={(event) => {
        event.preventDefault();
        void check();
      }}
    >
      <p className={section.sub}>{autoCheck && busy ? t.signedIn : t.checkLead}</p>
      {server.auth === 'personal_key'
        ? server.fields.map((field) => (
            <Field key={field.key} label={t.yourValue(field.label)} hint={field.hint || undefined}>
              <Input type={field.secret ? 'password' : 'text'} autoComplete="off" required value={values[field.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))} />
            </Field>
          ))
        : null}
      <Feedback error={error} />
      <div className={section.formActions}>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t.checking : server.snapshotAt ? t.refresh : t.check}
        </Button>
      </div>
    </form>
  );
}

function Actions({ server, onSaved, onRefresh, onEditAccess }: { server: McpServerView; onSaved: (next: McpServerView) => void; onRefresh: () => void; onEditAccess: () => void }) {
  const [title, setTitle] = useState(server.title);
  const [marks, setMarks] = useState<Mark[]>(() => marksOf(server));
  const [agents, setAgents] = useState(server.agents);
  const [shared, setShared] = useState<Record<string, string>>({});
  // The list of agents is loaded at every opening: an agent added since is offered too.
  const { state: allAgents } = useLoad(adminApi.agents);
  const { busy, error, run } = useAction();

  const save = (status?: 'enabled' | 'disabled') =>
    void run(async () => {
      const actions = marks.map((m) => ({ ...m, title: m.title.trim() || null }));
      onSaved((await adminApi.updateMcp(server.id, { title, actions, agents, ...(status ? { status } : {}) })).server);
    });
  const renewShared = () => void run(async () => onSaved((await adminApi.updateMcp(server.id, { sharedValues: shared })).server));

  return (
    <div className={section.form}>
      <Field label={t.title}>
        <Input required value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      {server.status === 'shared_auth_error' ? (
        <div className={styles.group}>
          <Pill tone="bad">{t.states.shared_auth_error}</Pill>
          {server.fields.map((field) => (
            <Field key={field.key} label={t.sharedValue(field.label)}>
              <Input type="password" autoComplete="new-password" value={shared[field.key] ?? ''} onChange={(e) => setShared((v) => ({ ...v, [field.key]: e.target.value }))} />
            </Field>
          ))}
          <div className={section.formActions}>
            <Button variant="primary" disabled={busy} onClick={renewShared}>
              {t.save}
            </Button>
          </div>
        </div>
      ) : null}
      <ActionsEditor server={server} marks={marks} onMarks={setMarks} agents={agents} allAgents={allAgents.status === 'ready' ? allAgents.data.agents.map((a) => ({ id: a.id, label: a.name })) : []} onAgents={setAgents} />
      <Feedback error={error} />
      <div className={styles.footer}>
        <div className={styles.footerSide}>
          <Button variant="ghost" disabled={busy} onClick={onRefresh}>
            {t.refresh}
          </Button>
          {server.status === 'draft' ? (
            <Button variant="ghost" disabled={busy} onClick={onEditAccess}>
              {t.edit}
            </Button>
          ) : null}
        </div>
        <div className={section.formActions}>
          {server.status === 'enabled' ? (
            <Button disabled={busy} onClick={() => save('disabled')}>
              {t.disable}
            </Button>
          ) : null}
          <Button variant={server.status === 'enabled' ? 'primary' : 'secondary'} disabled={busy} onClick={() => save()}>
            {t.save}
          </Button>
          {server.status === 'enabled' ? null : (
            <Button variant="primary" disabled={busy} onClick={() => save('enabled')}>
              {t.enable}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function McpServerDialog({ server, autoCheck, initialError, onClose, onChanged }: { server: McpServerView | null; autoCheck: boolean; initialError: ApiRequestError | null; onClose: () => void; onChanged: () => void }) {
  const [current, setCurrent] = useState(server);
  const [step, setStep] = useState<Step>(autoCheck ? 'check' : firstStep(server));
  const saved = (next: McpServerView, to: Step) => {
    setCurrent(next);
    setStep(to);
    onChanged();
  };
  return (
    <Modal open onClose={onClose} label={current ? current.title : t.dialog}>
      <div className={styles.dialogHead}>
        <h2 className={section.formTitle}>{current ? current.title : t.dialog}</h2>
        {current ? <Pill tone={current.status === 'enabled' ? 'ok' : current.status === 'draft' ? 'neutral' : 'bad'}>{t.states[current.status]}</Pill> : null}
        {/* On a phone the window covers most of the screen: closing by Esc or past the window is not obvious. */}
        <IconButton icon="x" label={t.close} className={styles.close} onClick={onClose} />
      </div>
      {initialError ? (
        <div className={styles.dialogNotice}>
          <Feedback error={initialError} />
        </div>
      ) : null}
      {step === 'setup' ? <Setup server={current} onSaved={(next) => saved(next, 'check')} /> : null}
      {step === 'check' && current ? <Check server={current} autoCheck={autoCheck} onChecked={(next) => saved(next, 'actions')} /> : null}
      {step === 'actions' && current ? <Actions server={current} onSaved={(next) => saved(next, 'actions')} onRefresh={() => setStep('check')} onEditAccess={() => setStep('setup')} /> : null}
    </Modal>
  );
}
