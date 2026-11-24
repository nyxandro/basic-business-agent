// ♡ of samples (docs/specs/[20.11.2026]-feedback-and-value.md, F6; owner 24.11): on the block of a document the agent made,
// before «Открыть», and in the bar of its viewer. One press puts the document into the knowledge base as a sample — the
// server guesses its kind from its name — in the base of the person's department, or in the one the person picks when
// there are several; a press on the filled heart takes it out. The hearts of one conversation share one answer of the
// server in the memory of screens (key ['example-marks', threadId]): a press shows at once on the block and in the viewer,
// and the answer is asked anew after it even when the heart pressed is gone (the viewer closed meanwhile).
import type { ExampleBase, ExampleMarksResponse } from '@bba/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { asApiError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { IconButton } from '../ui/Button.tsx';
import { Menu, MenuAnchor, MenuItem, MenuTitle } from '../ui/Menu.tsx';
import { useToast } from '../ui/Toast.tsx';
import { useLoad } from '../ui/use-load.ts';
import { exampleMarks, removeExample, saveExample } from './api.ts';
import styles from './feedback.module.css';

const t = ru.feedback.example;
const baseKey = (b: ExampleBase) => (b.scope === 'org' ? 'org' : b.departmentId);
const marksKey = (threadId: string) => ['example-marks', threadId] as const;

// `floatingMenu` — the menu «Куда добавить» lies in the top layer of the page: the glass card of the chat clips what leaves
// it. In the viewer's bar it stays in place: a floating menu lies under the viewer.
export function SampleHeart({ threadId, path, floatingMenu }: { threadId: string; path: string; floatingMenu: boolean }) {
  const toast = useToast();
  const memory = useQueryClient();
  const load = useCallback(() => exampleMarks(threadId), [threadId]);
  const { state, reload } = useLoad(load, marksKey(threadId));
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const answer = state.status === 'ready' ? state.data : null;
  const saved = answer?.saved.includes(path) ?? false;
  const fileName = path.split('/').pop() ?? path;

  async function change(to: boolean, request: () => Promise<unknown>, done: string) {
    const key = marksKey(threadId);
    setBusy(true);
    // An answer on its way would put the old state back over the press.
    await memory.cancelQueries({ queryKey: key, exact: true });
    memory.setQueryData<ExampleMarksResponse>(key, (now) => now && { ...now, saved: [...now.saved.filter((p) => p !== path), ...(to ? [path] : [])] });
    try {
      await request();
      toast(done);
    } catch (raw) {
      const error = asApiError(raw);
      toast(t.failed(error.message, error.code));
    } finally {
      setBusy(false);
      // What the server keeps now, for every heart of the conversation: the press is undone on a failure.
      void memory.invalidateQueries({ queryKey: key, exact: true });
    }
  }

  const add = (base: ExampleBase) => {
    setChoosing(false);
    void change(true, () => saveExample({ threadId, path, base: base.scope === 'org' ? { scope: 'org' } : { scope: 'department', departmentId: base.departmentId } }), t.added(base.name));
  };

  function press() {
    if (state.status === 'error') {
      toast(t.failed(state.error.message, state.error.code));
      reload();
      return;
    }
    if (!answer) return;
    if (saved) return void change(false, () => removeExample(threadId, path), t.removed);
    const [only, ...more] = answer.bases;
    if (!only) return toast(t.noBase);
    if (more.length > 0) return setChoosing(true);
    add(only);
  }

  return (
    <MenuAnchor>
      <IconButton
        icon={saved ? 'heartFilled' : 'heart'}
        size="sm"
        label={saved ? t.savedLabel(fileName) : t.addLabel(fileName)}
        title={saved ? t.saved : t.add}
        aria-pressed={saved}
        disabled={busy || state.status === 'loading'}
        className={saved ? styles.hearted : undefined}
        onClick={press}
      />
      {answer ? (
        <Menu open={choosing} onClose={() => setChoosing(false)} label={t.where} floating={floatingMenu}>
          <MenuTitle>{t.where}</MenuTitle>
          {answer.bases.map((b) => (
            <MenuItem key={baseKey(b)} onSelect={() => add(b)}>
              {b.name}
            </MenuItem>
          ))}
        </Menu>
      ) : null}
    </MenuAnchor>
  );
}
