// «База знаний» (docs/specs/[20.11.2026]-knowledge-base.md, sections 7 and 12): the documents agents answer by — the
// organisation's base and those of the person's departments — with their reading state, «Загрузить документы»,
// «Заменить», «Редакция от», «Повторить», «Удалить», and the synonyms of the base. Search by meaning is not built (owner
// 22.11, F4): the base searches by words.
import type { KbBasesResponse, KbDocumentDto, KbSynonymGroupDto } from '@bba/contracts';
import { useCallback, useRef, useState } from 'react';
import { api, apiForm } from '../api/client.ts';
import { Button, cx, IconButton } from '../ui/Button.tsx';
import { useConfirm } from '../ui/Confirm.tsx';
import { Card, EmptyState, PageHead, Pill, type Tone } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Field, Input } from '../ui/Field.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { useLoad } from '../ui/use-load.ts';
import models from './models.module.css';
import { Feedback, useAction } from './parts.tsx';
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

const ERRORS: Record<string, string> = {
  APP_KNOWLEDGE_FORMAT: 'Этот формат база знаний не читает.',
  APP_KNOWLEDGE_PASSWORD: 'Документ защищён паролем — сохраните без пароля и загрузите снова.',
  APP_KNOWLEDGE_NO_TEXT: 'Скан — текст не найден. Загрузите версию с текстом.',
  APP_KNOWLEDGE_BAD_TEXT: 'Текст документа не читается. Пересохраните документ из исходной программы.',
  APP_KNOWLEDGE_SLOW: 'Разбор не уложился во время — сервер был занят. Нажмите «Повторить».',
  APP_KNOWLEDGE_REPLACED: 'Пришла более новая редакция — читается она.',
};

function stateOf(d: KbDocumentDto): { tone: Tone; text: string } {
  if (d.status === 'pending') return { tone: 'neutral', text: d.currentVersion ? 'Разбираю новую редакцию…' : 'Разбираю…' };
  if (d.status === 'rejected') {
    const why = ERRORS[d.errorCode ?? ''] ?? 'Ошибка разбора.';
    return { tone: 'bad', text: d.currentVersion ? `Новая версия не принята: ${why} Агенты отвечают по прежней редакции.` : `${why} Код: ${d.errorCode ?? ''}` };
  }
  return { tone: d.warning ? 'warn' : 'ok', text: d.warning ?? `Готов · ${d.chunks ?? 0} фрагм.` };
}

function Documents({ department }: { department: string | null }) {
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
    if (await run(async () => (target ? kb.replace(target, list[0]!) : Promise.all(list.map((f) => kb.upload(department, f)))), target ? 'Новая редакция загружена' : 'Документы загружены')) reload();
  }
  if (state.status === 'loading') return <DelayedBar />;
  if (state.status === 'error') return <ErrorBanner error={state.error} onRetry={reload} />;
  const docs = state.data.documents;
  return (
    <>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>Документы</h2>
        <Button variant="primary" icon="plus" disabled={busy} onClick={() => picker.current?.click()}>
          Загрузить документы
        </Button>
        <input ref={picker} type="file" multiple hidden accept=".docx,.doc,.odt,.rtf,.pdf,.xlsx,.xls,.ods,.csv,.pptx,.ppt,.odp,.txt,.md,.html" onChange={(e) => void onFiles(e.target.files).finally(() => (e.target.value = ''))} />
      </div>
      <div className={styles.inset}>
        <Feedback error={error} />
        <p className={section.note}>Документы, по которым агенты отвечают сотрудникам, со ссылкой на документ, раздел и редакцию. Поиск по словам — с формами слов, синонимами, опечатками и кодами; поиск по смыслу пока не подключён.</p>
      </div>
      {docs.length === 0 ? (
        <EmptyState title="В базе пока нет документов" text="Загрузите регламенты, прайсы, условия — агенты будут отвечать по ним со ссылкой на документ." />
      ) : (
        <ul className={styles.phoneList} aria-label="Документы базы знаний">
          {docs.map((d) => {
            const st = stateOf(d);
            return (
              <li key={d.id} className={styles.phoneTask}>
                <div className={styles.phoneMain}>
                  <div className={styles.taskName}>{d.title}</div>
                  <div className={section.sub}>
                    {d.fileName}
                    {d.editionDate ? ` · редакция от ${d.editionDate.split('-').reverse().join('.')}` : ''}
                  </div>
                  <Pill tone={st.tone}>{st.text}</Pill>
                  <label className={styles.stageHeadRow}>
                    Редакция от
                    <Input
                      type="date"
                      aria-label={`Редакция от: ${d.title}`}
                      value={edition[d.id] ?? d.editionDate ?? ''}
                      onChange={(e) => setEdition((all) => ({ ...all, [d.id]: e.target.value }))}
                      onBlur={(e) => {
                        const next = e.target.value || null;
                        if (next !== d.editionDate) void run(() => kb.patch(d.id, { editionDate: next }), 'Сохранено').then((ok) => ok && reload());
                      }}
                    />
                  </label>
                </div>
                {d.status === 'rejected' ? (
                  <Button disabled={busy} onClick={() => void run(() => kb.retry(d.id), null).then((ok) => ok && reload())}>
                    Повторить
                  </Button>
                ) : null}
                <Button
                  disabled={busy}
                  onClick={() => {
                    replacing.current = d.id;
                    picker.current?.click();
                  }}
                >
                  Заменить
                </Button>
                <IconButton
                  icon="trash"
                  label={`Удалить: ${d.title}`}
                  onClick={() =>
                    void confirm({ title: `Удалить «${d.title}»?`, text: 'Агенты перестанут находить его сразу. Копии, которые агенты уже взяли в разговоры, останутся там.', confirmLabel: 'Удалить', danger: true }).then(async (yes) => {
                      if (yes && (await run(() => kb.remove(d.id), 'Документ удалён'))) reload();
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
  return (
    <div className={styles.inset}>
      <p className={section.note}>Слова, которые в вашей компании значат одно и то же. Агент найдёт документ, даже если сотрудник спросил другим словом. Общий словарь (возврат — рекламация, договор — контракт…) уже работает.</p>
      <Feedback error={error} />
      {state.data.groups.length === 0 ? <p className={section.note}>Свои синонимы пока не добавлены.</p> : null}
      <ul className={styles.phoneList} aria-label="Синонимы">
        {state.data.groups.map((g) => (
          <li key={g.id} className={styles.phoneTask}>
            <div className={styles.phoneMain}>{g.words.join(', ')}</div>
            <IconButton icon="trash" label={`Удалить группу: ${g.words.join(', ')}`} onClick={() => void run(() => kb.removeSynonyms(department, g.id), 'Удалено').then((ok) => ok && reload())} />
          </li>
        ))}
      </ul>
      <form
        className={section.row}
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => kb.saveSynonyms(department, null, words(draft)), 'Сохранено').then((ok) => {
            if (!ok) return;
            setDraft('');
            reload();
          });
        }}
      >
        <Field label="Добавить группу" hint="Слова через запятую.">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="отгул, выходной день" />
        </Field>
        <Button type="submit" variant="primary" disabled={busy || words(draft).length < 2}>
          Добавить группу
        </Button>
      </form>
    </div>
  );
}

export function KnowledgeSection() {
  const { state, reload } = useLoad(kb.bases, ['knowledge', 'bases']);
  const [base, setBase] = useState<string | null | undefined>(undefined);
  const [tab, setTab] = useState<'documents' | 'synonyms'>('documents');
  const head = <PageHead title="База знаний" lead="Документы, по которым агенты отвечают сотрудникам. Документы отдела видят только его сотрудники." />;
  if (state.status === 'loading') return <div className={section.stack}>{head}<DelayedBar /></div>;
  if (state.status === 'error') return <div className={section.stack}>{head}<ErrorBanner error={state.error} onRetry={reload} /></div>;
  const bases = [...(state.data.org ? [{ id: null as string | null, name: 'Для всей организации' }] : []), ...state.data.departments.map((d) => ({ id: d.id, name: d.name }))];
  const current = base === undefined ? (bases[0]?.id ?? null) : base;
  if (bases.length === 0) return <div className={section.stack}>{head}<EmptyState title="Нет баз, которые вы ведёте" text="Вести базу знаний может сотрудник с правом «Документы организации» или «Документы отдела»." /></div>;
  return (
    <div className={section.stack}>
      {head}
      <div role="group" aria-label="База" className={models.chips}>
        {bases.map((b) => (
          <button key={b.id ?? 'org'} type="button" aria-pressed={current === b.id} className={cx(models.chip, current === b.id && models.chipOn)} onClick={() => setBase(b.id)}>
            {b.name}
          </button>
        ))}
      </div>
      <div role="group" aria-label="Раздел базы" className={models.chips}>
        <button type="button" aria-pressed={tab === 'documents'} className={cx(models.chip, tab === 'documents' && models.chipOn)} onClick={() => setTab('documents')}>
          Документы
        </button>
        <button type="button" aria-pressed={tab === 'synonyms'} className={cx(models.chip, tab === 'synonyms' && models.chipOn)} onClick={() => setTab('synonyms')}>
          Синонимы
        </button>
      </div>
      <Card className={`${section.tableCard} rise`}>{tab === 'documents' ? <Documents key={current ?? 'org'} department={current} /> : <Synonyms key={current ?? 'org'} department={current} />}</Card>
    </div>
  );
}
