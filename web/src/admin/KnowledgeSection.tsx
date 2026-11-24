// «База знаний» (docs/specs/[20.11.2026]-knowledge-base.md, sections 7 and 12): the documents agents answer by — the
// organisation's base and those of the person's departments — with their reading state, «Загрузить документы»,
// «Заменить», «Редакция от», «Повторить», «Удалить», and the synonyms of the base. Search by meaning is not built (owner
// 22.11, F4): the base searches by words.
import type { KbBasesResponse, KbDocumentDto, KbSynonymGroupDto } from '@bba/contracts';
import { useCallback, useRef, useState } from 'react';
import { api, apiForm } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button, cx, IconButton } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, EmptyState, PageHead, Pill, type Tone } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import chips from '../ui/chips.module.css';
import { Feedback, useAction } from '../ui/form-parts.tsx';
import section from './section.module.css';
import styles from './tasks.module.css';

const K = '/app/api/knowledge';
const q = (department: string | null) => (department ? `?department=${encodeURIComponent(department)}` : '');
const kb = {
  bases: () => api<KbBasesResponse>('GET', `${K}/bases`),
  documents: (department: string | null) => api<{ documents: KbDocumentDto[] }>('GET', `${K}/documents${q(department)}`),
  upload: (department: string | null, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return apiForm<{ id: string }>(`${K}/documents${q(department)}`, form);
  },
  replace: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return apiForm<{ ok: true }>(`${K}/documents/${encodeURIComponent(id)}/versions`, form);
  },
  patch: (id: string, body: { title?: string; editionDate?: string | null }) => api<{ ok: true }>('PATCH', `${K}/documents/${encodeURIComponent(id)}`, body),
  remove: (id: string) => api<{ ok: true }>('DELETE', `${K}/documents/${encodeURIComponent(id)}`),
  retry: (id: string) => api<{ ok: true }>('POST', `${K}/documents/${encodeURIComponent(id)}/retry`, {}),
  synonyms: (department: string | null) => api<{ groups: KbSynonymGroupDto[] }>('GET', `${K}/synonyms${q(department)}`),
  saveSynonyms: (department: string | null, id: string | null, words: string[]) =>
    id ? api<KbSynonymGroupDto>('PUT', `${K}/synonyms/${encodeURIComponent(id)}${q(department)}`, { words }) : api<KbSynonymGroupDto>('POST', `${K}/synonyms${q(department)}`, { words }),
  removeSynonyms: (department: string | null, id: string) => api<{ ok: true }>('DELETE', `${K}/synonyms/${encodeURIComponent(id)}${q(department)}`),
};

const t = ru.knowledge;

function stateOf(d: KbDocumentDto): { tone: Tone; text: string } {
  if (d.status === 'pending') return { tone: 'neutral', text: d.currentVersion ? t.state.readingNew : t.state.reading };
  if (d.status === 'rejected') {
    const why = t.errors[d.errorCode ?? ''] ?? t.state.failed;
    return { tone: 'bad', text: d.currentVersion ? t.state.newRefused(why) : t.state.refused(why, d.errorCode ?? '') };
  }
  return { tone: d.warning ? 'warn' : 'ok', text: d.warning ?? t.state.ready(d.chunks ?? 0) };
}

// `kind` — the documents of the base, or the samples employees marked in the chat (docs/specs/[20.11.2026]-feedback-and-value.md):
// a sample is not uploaded or replaced here, only removed.
function Documents({ department, kind }: { department: string | null; kind: 'document' | 'example' }) {
  const load = useCallback(() => kb.documents(department), [department]);
  const { state, reload } = useLoad(load);
  const { busy, error, run } = useAction();
  const confirm = useConfirm();
  const picker = useRef<HTMLInputElement>(null);
  const replacing = useRef<string | null>(null);
  const [edition, setEdition] = useState<Record<string, string>>({});
  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const target = replacing.current;
    replacing.current = null;
    const list = [...files];
    if (await run(async () => (target ? kb.replace(target, list[0]!) : Promise.all(list.map((f) => kb.upload(department, f)))), target ? t.replaced : t.uploaded)) reload();
  }
  if (state.status === 'loading') return <DelayedBar />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const docs = state.data.documents.filter((d) => d.kind === kind);
  const samples = kind === 'example';
  return (
    <>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>{samples ? t.examples : t.documents}</h2>
        {samples ? null : (
          <Button variant="primary" icon="plus" disabled={busy} onClick={() => picker.current?.click()}>
            {t.upload}
          </Button>
        )}
        <input ref={picker} type="file" multiple hidden accept=".docx,.doc,.odt,.rtf,.pdf,.xlsx,.xls,.ods,.csv,.pptx,.ppt,.odp,.txt,.md,.html" onChange={(e) => void onFiles(e.target.files).finally(() => (e.target.value = ''))} />
      </div>
      <div className={styles.inset}>
        <Feedback error={error} />
        <p className={section.note}>{samples ? t.examplesNote : t.note}</p>
      </div>
      {docs.length === 0 ? (
        samples ? <EmptyState title={t.examplesEmpty} text={t.examplesEmptyText} /> : <EmptyState title={t.empty} text={t.emptyText} />
      ) : (
        <ul className={styles.phoneList} aria-label={samples ? t.examplesLabel : t.listLabel}>
          {docs.map((d) => {
            const st = stateOf(d);
            return (
              <li key={d.id} className={styles.phoneTask}>
                <div className={styles.phoneMain}>
                  <div className={styles.taskName}>{d.title}</div>
                  <div className={section.sub}>
                    {samples ? t.exampleOf(d.docType ?? t.examples, d.markedBy) : d.fileName}
                    {d.editionDate ? t.editionShort(d.editionDate.split('-').reverse().join('.')) : ''}
                  </div>
                  <Pill tone={st.tone}>{st.text}</Pill>
                  {samples ? null : (
                    <label className={styles.stageHeadRow}>
                      {t.edition}
                      <Input
                        type="date"
                        aria-label={t.editionOf(d.title)}
                        value={edition[d.id] ?? d.editionDate ?? ''}
                        onChange={(e) => setEdition((all) => ({ ...all, [d.id]: e.target.value }))}
                        onBlur={(e) => {
                          const next = e.target.value || null;
                          if (next !== d.editionDate) void run(() => kb.patch(d.id, { editionDate: next }), t.saved).then((ok) => ok && reload());
                        }}
                      />
                    </label>
                  )}
                </div>
                {d.status === 'rejected' ? (
                  <Button disabled={busy} onClick={() => void run(() => kb.retry(d.id), null).then((ok) => ok && reload())}>
                    {t.retry}
                  </Button>
                ) : null}
                {samples ? null : (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      replacing.current = d.id;
                      picker.current?.click();
                    }}
                  >
                    {t.replace}
                  </Button>
                )}
                <IconButton
                  icon="trash"
                  label={t.removeLabel(d.title)}
                  onClick={() =>
                    void confirm({ title: t.removeTitle(d.title), text: t.removeText, confirmLabel: t.remove, danger: true }).then(async (yes) => {
                      if (yes && (await run(() => kb.remove(d.id), t.removed))) reload();
                    })
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function Synonyms({ department }: { department: string | null }) {
  const load = useCallback(() => kb.synonyms(department), [department]);
  const { state, reload } = useLoad(load);
  const { busy, error, run } = useAction();
  const [draft, setDraft] = useState('');
  if (state.status === 'loading') return <DelayedBar />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const words = (text: string) => text.split(',').map((w) => w.trim()).filter(Boolean);
  // Laid out as the tabs of documents: a head, the note, the list edge to edge, then the form.
  return (
    <>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>{t.synonyms}</h2>
      </div>
      <div className={styles.inset}>
        <p className={section.note}>{t.synonymsNote}</p>
        <Feedback error={error} />
        {state.data.groups.length === 0 ? <p className={section.note}>{t.synonymsEmpty}</p> : null}
      </div>
      <ul className={styles.phoneList} aria-label={t.synonyms}>
        {state.data.groups.map((g) => (
          <li key={g.id} className={styles.phoneTask}>
            <div className={styles.phoneMain}>{g.words.join(', ')}</div>
            <IconButton icon="trash" label={t.synonymsRemove(g.words.join(', '))} onClick={() => void run(() => kb.removeSynonyms(department, g.id), t.synonymsRemoved).then((ok) => ok && reload())} />
          </li>
        ))}
      </ul>
      <form
        className={styles.synonymForm}
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => kb.saveSynonyms(department, null, words(draft)), t.saved).then((ok) => {
            if (!ok) return;
            setDraft('');
            reload();
          });
        }}
      >
        <Field label={t.synonymsAdd} hint={t.synonymsHint} className={styles.synonymField}>
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t.synonymsPlaceholder} />
        </Field>
        <Button type="submit" variant="primary" disabled={busy || words(draft).length < 2}>
          {t.synonymsAdd}
        </Button>
      </form>
    </>
  );
}

export function KnowledgeSection() {
  const { state, reload } = useLoad(kb.bases, ['knowledge', 'bases']);
  const [base, setBase] = useState<string | null | undefined>(undefined);
  const [tab, setTab] = useState<'documents' | 'examples' | 'synonyms'>('documents');
  const head = <PageHead title={t.title} lead={t.lead} />;
  if (state.status === 'loading') return <div className={section.stack}>{head}<DelayedBar /></div>;
  if (state.status === 'error') return <div className={section.stack}>{head}<ErrorBanner error={state.error} onRetry={reload} /></div>;
  const bases = [...(state.data.org ? [{ id: null as string | null, name: t.orgBase }] : []), ...state.data.departments.map((d) => ({ id: d.id, name: d.name }))];
  const current = base === undefined ? (bases[0]?.id ?? null) : base;
  if (bases.length === 0) return <div className={section.stack}>{head}<EmptyState title={t.noBases} text={t.noBasesText} /></div>;
  return (
    <div className={section.stack}>
      {head}
      <div role="group" aria-label={t.basesLabel} className={chips.row}>
        {bases.map((b) => (
          <button key={b.id ?? 'org'} type="button" aria-pressed={current === b.id} className={cx(chips.chip, current === b.id && chips.on)} onClick={() => setBase(b.id)}>
            {b.name}
          </button>
        ))}
      </div>
      <div role="group" aria-label={t.tabsLabel} className={chips.row}>
        <button type="button" aria-pressed={tab === 'documents'} className={cx(chips.chip, tab === 'documents' && chips.on)} onClick={() => setTab('documents')}>
          {t.documents}
        </button>
        <button type="button" aria-pressed={tab === 'examples'} className={cx(chips.chip, tab === 'examples' && chips.on)} onClick={() => setTab('examples')}>
          {t.examples}
        </button>
        <button type="button" aria-pressed={tab === 'synonyms'} className={cx(chips.chip, tab === 'synonyms' && chips.on)} onClick={() => setTab('synonyms')}>
          {t.synonyms}
        </button>
      </div>
      <Card className={`${section.tableCard} rise`}>{tab === 'synonyms' ? <Synonyms key={current ?? 'org'} department={current} /> : <Documents key={`${current ?? 'org'}:${tab}`} department={current} kind={tab === 'examples' ? 'example' : 'document'} />}</Card>
    </div>
  );
}
