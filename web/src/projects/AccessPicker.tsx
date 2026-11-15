// «Кому открыт проект» (spec, section 8.20): «Только я», «Выбранным» — departments (the person's own,
// others, several) and colleagues found by name or e-mail, together — or «Всей организации». Used by
// the window of a new project and by «Настроить доступ».
import type { ColleagueDto, ProjectAccessDto, ProjectAccessInput, ProjectAccessMode } from '@bba/contracts';
import { useEffect, useState } from 'react';
import { asApiError } from '../api/client.ts';
import { useMe } from '../auth/session.tsx';
import { ru } from '../i18n/ru.ts';
import { cx, IconButton } from '../ui/Button.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Input } from '../ui/Field.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { Segmented } from '../ui/Segmented.tsx';
import { useLoad } from '../ui/use-load.ts';
import { fetchColleagues, fetchDepartments } from './api.ts';
import styles from './projects.module.css';

// A person of the list: the found colleague, or one the list already has (maybe blocked since).
export interface PickedPerson {
  id: string;
  name: string;
  email: string;
  blocked: boolean;
}

export interface AccessDraft {
  mode: ProjectAccessMode;
  departmentIds: string[];
  people: PickedPerson[];
}

export const PRIVATE_DRAFT: AccessDraft = { mode: 'private', departmentIds: [], people: [] };
const SEARCH_MIN = 2;
const SEARCH_WAIT_MS = 250;

export function draftOf(access: ProjectAccessDto): AccessDraft {
  return { mode: access.mode, departmentIds: access.departments.map((d) => d.id), people: access.people };
}

// Another mode than «Выбранным» carries no lists: the server refuses lists there.
export function inputOf(draft: AccessDraft): ProjectAccessInput {
  return draft.mode === 'list' ? { mode: 'list', departmentIds: draft.departmentIds, userIds: draft.people.map((p) => p.id) } : { mode: draft.mode, departmentIds: [], userIds: [] };
}

export const draftReady = (draft: AccessDraft) => draft.mode !== 'list' || draft.departmentIds.length + draft.people.length > 0;

export function sameDraft(a: AccessDraft, b: AccessDraft): boolean {
  const x = inputOf(a);
  const y = inputOf(b);
  const same = (p: string[], q: string[]) => p.length === q.length && [...p].sort().join() === [...q].sort().join();
  return x.mode === y.mode && same(x.departmentIds, y.departmentIds) && same(x.userIds, y.userIds);
}

// The creator's line about the access: «Только вы», «Открыт всей организации», «Открыт: Продажи, Пётр…».
export function accessText(access: ProjectAccessDto): string {
  if (access.mode === 'org') return ru.projects.accessOrg;
  if (access.mode === 'private') return ru.projects.accessOnlyYou;
  return ru.projects.accessList([...access.departments.map((d) => d.name), ...access.people.map((p) => p.name)]);
}

function Colleagues({ picked, onPick }: { picked: PickedPerson[]; onPick: (person: ColleagueDto) => void }) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; colleagues: ColleagueDto[] } | null>(null);
  const [failed, setFailed] = useState<ReturnType<typeof asApiError> | null>(null);
  const q = query.trim();
  useEffect(() => {
    if (q.length < SEARCH_MIN) return;
    let live = true;
    const timer = setTimeout(() => {
      fetchColleagues(q).then(
        ({ colleagues }) => live && (setFound({ query: q, colleagues }), setFailed(null)),
        (raw: unknown) => live && setFailed(asApiError(raw)),
      );
    }, SEARCH_WAIT_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);
  const shown = found && found.query === q ? found.colleagues.filter((c) => !picked.some((p) => p.id === c.id)) : null;
  return (
    <div className={styles.peopleSearch}>
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={ru.projects.peopleSearch} aria-label={ru.projects.peopleSearch} />
      {q.length > 0 && q.length < SEARCH_MIN ? <p className={styles.empty}>{ru.projects.peopleShort}</p> : null}
      {failed && q.length >= SEARCH_MIN ? <ErrorBanner title={ru.projects.peopleFailed} error={failed} /> : null}
      {q.length >= SEARCH_MIN && shown ? (
        shown.length === 0 ? (
          <p className={styles.empty}>{ru.projects.peopleNone}</p>
        ) : (
          <ul className={styles.found} aria-label={ru.projects.people}>
            {shown.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={styles.foundPerson}
                  onClick={() => {
                    onPick(c);
                    setQuery('');
                  }}
                >
                  <span className={styles.rowName}>{c.name}</span>
                  <span className={styles.rowMeta}>{[c.email, ...c.departments].join(' · ')}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

export function AccessPicker({ value, onChange, closing }: { value: AccessDraft; onChange: (next: AccessDraft) => void; closing: boolean }) {
  const me = useMe();
  const { state, reload } = useLoad(fetchDepartments);
  const toggle = (id: string, on: boolean) => onChange({ ...value, departmentIds: on ? [...value.departmentIds, id] : value.departmentIds.filter((x) => x !== id) });
  return (
    <fieldset className={styles.access}>
      <legend className={styles.accessLegend}>{ru.projects.access}</legend>
      <Segmented
        label={ru.projects.access}
        options={(['private', 'list', 'org'] as const).map((mode) => ({ value: mode, label: ru.projects.accessModes[mode] }))}
        value={value.mode}
        onChange={(mode) => onChange({ ...value, mode })}
      />
      {value.mode === 'list' ? (
        <>
          <div className={styles.accessPart}>
            <span className={styles.accessLabel}>{ru.projects.departments}</span>
            {state.status === 'loading' ? <Skeleton rows={1} /> : null}
            {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
            {state.status === 'ready' && state.data.departments.length === 0 ? <p className={styles.empty}>{ru.projects.noDepartments}</p> : null}
            {state.status === 'ready' && state.data.departments.length > 0 ? (
              <div className={styles.checks}>
                {state.data.departments.map((d) => {
                  const on = value.departmentIds.includes(d.id);
                  return (
                    <label key={d.id} className={cx(styles.check, on && styles.checkOn)}>
                      <input type="checkbox" checked={on} onChange={(e) => toggle(d.id, e.target.checked)} />
                      <span>
                        {d.name}
                        <span className={styles.checkMeta}>
                          {' · '}
                          {ru.projects.departmentMembers(d.members)}
                          {me.departmentIds.includes(d.id) ? ` · ${ru.projects.ownDepartment}` : ''}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : null}
          </div>
          <div className={styles.accessPart}>
            <span className={styles.accessLabel}>{ru.projects.people}</span>
            {value.people.length > 0 ? (
              <ul className={styles.rows}>
                {value.people.map((p) => (
                  <li key={p.id} className={styles.row}>
                    <span className={styles.rowMain}>
                      <span className={styles.rowName}>{p.name}</span>
                      <span className={styles.rowMeta}>
                        {p.email}
                        {p.blocked ? ` · ${ru.projects.blocked}` : ''}
                      </span>
                    </span>
                    <IconButton icon="x" size="sm" label={ru.projects.removePerson(p.name)} onClick={() => onChange({ ...value, people: value.people.filter((x) => x.id !== p.id) })} />
                  </li>
                ))}
              </ul>
            ) : null}
            <Colleagues picked={value.people} onPick={(c) => onChange({ ...value, people: [...value.people, { id: c.id, name: c.name, email: c.email, blocked: false }] })} />
          </div>
        </>
      ) : null}
      <p className={styles.empty}>{ru.projects.accessHint}</p>
      {closing ? <p className={styles.empty}>{ru.projects.accessCloseHint}</p> : null}
    </fieldset>
  );
}
