// A memory as a list of entries (spec, section 8.26): the block «Память проекта» on the page of a project and
// «Моя память». Add, change and remove an entry; a removal has «Вернуть» instead of a question. A change saved
// over a version someone else (a colleague, an agent) changed meanwhile keeps the person's text and shows what
// is there now; a removed entry keeps the text too, to be saved as a new one.
import { MEMORY_ENTRY_MAX_CHARS, MEMORY_NEARLY_FULL_SHARE, type MemoryEntryDto, type MemoryListDto } from '@bba/contracts';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ApiRequestError, asApiError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button, cx, IconButton } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { TextArea } from '../ui/Field.tsx';
import { dayLabel } from '../i18n/format.ts';
import { DelayedBar } from '../ui/Loading.tsx';
import { Menu, MenuAnchor, MenuItem } from '../ui/Menu.tsx';
import { useToast } from '../ui/Toast.tsx';
import { useLoad } from '../ui/use-load.ts';
import { addMemoryEntry, changeMemoryEntry, fetchMemory, memoryKey, removeMemoryEntry, type MemoryTarget } from './api.ts';
import styles from './memory.module.css';

const CONFLICT = 'APP_MEMORY_CONFLICT';
const GONE = 'APP_MEMORY_ENTRY_NOT_FOUND';
const FULL = 'APP_MEMORY_FULL';

// The field of a new entry (`id` null) or of an entry being changed.
interface Draft {
  id: string | null;
  text: string;
  // The text as it stands now: saving it unchanged would only move the entry to the person.
  original: string;
  version: number;
  // What happened to the entry while the person was changing it.
  notice: { kind: 'conflict'; current: string } | { kind: 'gone' } | null;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const chars = (text: string) => [...text].length;

function editorLine(entry: MemoryEntryDto, target: MemoryTarget): string {
  if (target.kind === 'personal') return entry.editor.byAgent ? ru.memory.agent : ru.memory.you;
  const name = entry.editor.name ?? ru.memory.formerEmployee;
  return entry.editor.byAgent ? ru.memory.byAgent(name) : name;
}

function Usage({ list }: { list: MemoryListDto }) {
  if (list.usedChars >= list.maxChars) return <p className={cx(styles.usage, styles.usageFull)}>{ru.memory.full}</p>;
  if (list.usedChars < list.maxChars * MEMORY_NEARLY_FULL_SHARE) return null;
  const n = (v: number) => v.toLocaleString('ru-RU');
  return <p className={styles.usage}>{ru.memory.nearlyFull(n(list.usedChars), n(list.maxChars))}</p>;
}

function Field({ draft, busy, onText, onSave, onCancel, onSaveAsNew }: { draft: Draft; busy: boolean; onText: (text: string) => void; onSave: () => void; onCancel: () => void; onSaveAsNew: () => void }) {
  const length = chars(oneLine(draft.text));
  const over = length > MEMORY_ENTRY_MAX_CHARS;
  const unchanged = oneLine(draft.text) === oneLine(draft.original);
  return (
    <div className={styles.field}>
      {draft.notice?.kind === 'conflict' ? (
        <p className={styles.notice} role="alert">
          {ru.memory.conflict(draft.notice.current)}
        </p>
      ) : null}
      {draft.notice?.kind === 'gone' ? (
        <p className={styles.notice} role="alert">
          {ru.memory.gone}
        </p>
      ) : null}
      <TextArea aria-label={ru.memory.fieldLabel} placeholder={ru.memory.fieldHint} rows={3} value={draft.text} onChange={(e) => onText(e.target.value)} autoFocus />
      <div className={styles.fieldFoot}>
        <span className={cx(styles.count, over && styles.countOver)}>{ru.memory.chars(length, MEMORY_ENTRY_MAX_CHARS)}</span>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {ru.memory.cancel}
        </Button>
        {draft.notice?.kind === 'gone' ? (
          <Button variant="primary" disabled={busy || length === 0 || over} onClick={onSaveAsNew}>
            {ru.memory.saveAsNew}
          </Button>
        ) : (
          <Button variant="primary" disabled={busy || length === 0 || over || unchanged} onClick={onSave}>
            {ru.memory.save}
          </Button>
        )}
      </div>
    </div>
  );
}

function RowMenu({ entry, onEdit, onRemove }: { entry: MemoryEntryDto; onEdit: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const label = ru.memory.actions(entry.number);
  return (
    <MenuAnchor className={cx(styles.more, open && styles.moreOpen)}>
      <IconButton icon="dots" size="sm" label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      <Menu open={open} onClose={() => setOpen(false)} label={label} width={200} floating>
        <MenuItem icon="edit" onSelect={() => (setOpen(false), onEdit())}>
          {ru.memory.edit}
        </MenuItem>
        <MenuItem icon="trash" danger onSelect={() => (setOpen(false), onRemove())}>
          {ru.memory.remove}
        </MenuItem>
      </Menu>
    </MenuAnchor>
  );
}

// `projectId` — the memory of that project; without it — the person's own. `footer` is drawn under the list
// once it is loaded («Забыть всё» of «Моя память»).
export function MemoryEntries({ projectId, title, hint, empty, failed, readOnlyNote, footer }: { projectId?: string; title?: string; hint: ReactNode; empty: ReactNode; failed: string; readOnlyNote?: string; footer?: (list: MemoryListDto, reload: () => void) => ReactNode }) {
  const target = useMemo<MemoryTarget>(() => (projectId ? { kind: 'project', projectId } : { kind: 'personal' }), [projectId]);
  const load = useCallback(() => fetchMemory(target), [target]);
  const { state, reload } = useLoad(load, memoryKey(target));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const toast = useToast();
  const readOnly = state.status === 'ready' && state.data.readOnly;
  // A new entry, or one removed while the person was changing it: its field stands above the list.
  const loose = draft !== null && (draft.id === null || (state.status === 'ready' && !state.data.entries.some((e) => e.id === draft.id)));
  // One field at a time: another «Изменить» or «Добавить запись» would drop what is typed in the open one.
  const canAdd = state.status === 'ready' && !readOnly && draft === null;

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (raw) {
      setError(asApiError(raw));
    } finally {
      setBusy(false);
    }
  }

  const add = (text: string) =>
    act(async () => {
      await addMemoryEntry(target, text);
      setDraft(null);
      toast(ru.memory.added);
      reload();
    });

  // A change over another version: the person's text stays, the field now saves over what is there.
  const save = (d: Draft) =>
    act(async () => {
      try {
        await changeMemoryEntry(target, d.id!, d.text, d.version);
      } catch (raw) {
        const failure = asApiError(raw);
        if (failure.code !== CONFLICT && failure.code !== GONE) throw failure;
        const now = (await fetchMemory(target)).entries.find((e) => e.id === d.id);
        setDraft({ ...d, ...(now ? { version: now.version, original: now.text, notice: { kind: 'conflict', current: now.text } } : { notice: { kind: 'gone' } }) });
        reload();
        return;
      }
      setDraft(null);
      toast(ru.memory.saved);
      reload();
    });

  const restore = (text: string) =>
    void addMemoryEntry(target, text).then(reload, (raw: unknown) => {
      const failure = asApiError(raw);
      setError(failure.code === FULL ? new ApiRequestError({ code: FULL, message: ru.memory.restoreFailed(text), status: failure.status }) : failure);
    });

  const remove = (entry: MemoryEntryDto) =>
    act(async () => {
      const removed = await removeMemoryEntry(target, entry.id);
      reload();
      toast(ru.memory.removed, { label: ru.memory.undo, run: () => restore(removed.text) });
    });

  const field = (d: Draft) => (
    <Field
      draft={d}
      busy={busy}
      onText={(text) => setDraft({ ...d, text })}
      onCancel={() => setDraft(null)}
      onSave={() => void (d.id === null ? add(d.text) : save(d))}
      onSaveAsNew={() => void add(d.text)}
    />
  );

  return (
    <div className={styles.memory}>
      {title || canAdd ? (
        <div className={styles.head}>
          {title ? <h2 className={styles.title}>{title}</h2> : <span className={styles.title} />}
          {canAdd ? (
            <Button icon="plus" disabled={busy} onClick={() => setDraft({ id: null, text: '', original: '', version: 0, notice: null })}>
              {ru.memory.add}
            </Button>
          ) : null}
        </div>
      ) : null}
      <p className={styles.hint}>{hint}</p>
      {readOnly && readOnlyNote ? <p className={styles.hint}>{readOnlyNote}</p> : null}
      {error ? <ErrorBanner error={error} /> : null}
      {state.status === 'loading' ? <DelayedBar /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} title={failed} onRetry={reload} /> : null}
      {state.status === 'ready' ? (
        <>
          <Usage list={state.data} />
          {loose ? field(draft) : null}
          {state.data.entries.length === 0 && !loose ? <p className={styles.empty}>{empty}</p> : null}
          {state.data.entries.length > 0 ? (
            <ul className={styles.rows}>
              {state.data.entries.map((entry) => (
                <li key={entry.id} className={styles.row}>
                  {draft?.id === entry.id ? (
                    field(draft)
                  ) : (
                    <>
                      <span className={styles.rowMain}>
                        <span className={styles.text}>{entry.text}</span>
                        <span className={styles.meta}>
                          {editorLine(entry, target)} · {dayLabel(entry.updatedAt)}
                        </span>
                      </span>
                      {readOnly || draft !== null ? null : <RowMenu entry={entry} onEdit={() => setDraft({ id: entry.id, text: entry.text, original: entry.text, version: entry.version, notice: null })} onRemove={() => void remove(entry)} />}
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {footer ? footer(state.data, reload) : null}
        </>
      ) : null}
    </div>
  );
}
