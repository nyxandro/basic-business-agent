// «Интерфейс» (spec, section 8.17): how the chat looks for every employee. The first setting is the
// agent's mark, one for all agents: an icon of the set, the admin's own picture or none. The sample
// shows it in the light and the dark theme at once, before saving; after saving, the admin's own
// chat changes at once (the session is read again), others' — when they next open the page.
import { AGENT_ICONS, type AgentIcon, type AgentMark, type AgentMarkKind, type InterfaceAdminState } from '@bba/contracts';
import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, asApiError } from '../api/client.ts';
import { useSession } from '../auth/session.tsx';
import { AgentMarkView } from '../chat/AgentMark.tsx';
import { ru } from '../i18n/ru.ts';
import { Button, cx } from '../ui/Button.tsx';
import { Card, CardHead, PageHead } from '../ui/Display.tsx';
import { ErrorBanner } from '../ui/ErrorBanner.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Skeleton } from '../ui/Loading.tsx';
import { Segmented } from '../ui/Segmented.tsx';
import { useLoad } from '../ui/use-load.ts';
import { AgentImageError, prepareAgentImage } from './agent-image.ts';
import { adminApi } from './api.ts';
import styles from './interface.module.css';
import { Feedback, useAction } from './parts.tsx';
import section from './section.module.css';

const t = ru.admin.interface;
const KINDS: AgentMarkKind[] = ['icon', 'image', 'none'];

// A picture prepared in this browser and not saved yet; its address lives while it is shown.
type Picked = { blob: Blob; url: string };

function pickError(error: unknown): ApiRequestError {
  if (!(error instanceof AgentImageError)) return asApiError(error);
  if (error.reason === 'not-prepared') {
    // Not the file but the browser: the details are kept for diagnosis.
    console.error('agent image preparation failed', error);
    return new ApiRequestError({ code: 'APP_AGENT_IMAGE_PREPARE_FAILED', message: t.notPrepared, status: 0, cause: error });
  }
  return new ApiRequestError({ code: 'APP_AGENT_IMAGE_INVALID', message: error.reason === 'too-big' ? t.tooBig : t.unreadable, status: 0, cause: error });
}

function IconChoice({ value, onChange }: { value: AgentIcon; onChange: (next: AgentIcon) => void }) {
  return (
    <div role="radiogroup" aria-label={t.iconLabel} className={styles.icons}>
      {AGENT_ICONS.map((icon) => (
        <button key={icon} type="button" role="radio" aria-checked={icon === value} aria-label={t.icons[icon]} title={t.icons[icon]} className={cx(styles.iconOption, icon === value && styles.iconOn)} onClick={() => onChange(icon)}>
          <Icon name={icon} size={20} />
        </button>
      ))}
    </div>
  );
}

function PictureChoice({ url, preparing, onFile }: { url: string | null; preparing: boolean; onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className={styles.picture}>
      <span className={styles.pictureFrame}>{url ? <img src={url} alt={t.picture} className={styles.pictureImg} /> : <Icon name="file" size={22} />}</span>
      <div className={styles.pictureText}>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          aria-label={t.fileLabel}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            // The same file chosen again after an error must fire the change again.
            e.currentTarget.value = '';
            if (file) onFile(file);
          }}
        />
        <Button icon={url ? 'redo' : 'plus'} disabled={preparing} onClick={() => input.current?.click()}>
          {preparing ? t.preparing : url ? t.replace : t.choose}
        </Button>
        <span className={section.sub}>{t.pictureHint}</span>
      </div>
    </div>
  );
}

// The words of an agent as the chat draws them, in a theme of its own.
function Sample({ mark, theme, label }: { mark: AgentMark | null; theme: 'light' | 'dark'; label: string }) {
  return (
    <figure className={styles.sample} data-theme-scope={theme}>
      <figcaption className={styles.sampleLabel}>{label}</figcaption>
      <div className={styles.sampleRow}>
        {/* null: «Своя картинка» chosen, no picture yet — an empty circle in its place. */}
        {mark ? <AgentMarkView mark={mark} /> : <span className={styles.sampleEmpty} aria-hidden="true" />}
        <p className={styles.sampleText}>{t.sampleText}</p>
      </div>
    </figure>
  );
}

function AgentMarkForm({ initial }: { initial: InterfaceAdminState }) {
  const [saved, setSaved] = useState(initial);
  const [kind, setKind] = useState(initial.agentMark);
  const [icon, setIcon] = useState(initial.agentIcon);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [pickFailure, setPickFailure] = useState<ApiRequestError | null>(null);
  const { busy, error, run } = useAction();
  const { refresh } = useSession();
  // A picture prepared after the admin left the page gets no address: nothing would let it go.
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => () => {
    if (picked) URL.revokeObjectURL(picked.url);
  }, [picked]);

  const pictureUrl = picked?.url ?? saved.image?.url ?? null;
  // A prepared picture goes to the server only with «Своя картинка».
  const newPicture = kind === 'image' ? picked : null;
  const changed = kind !== saved.agentMark || icon !== saved.agentIcon || newPicture !== null;
  const ready = kind !== 'image' || pictureUrl !== null;
  const mark: AgentMark | null = kind === 'none' ? { kind: 'none' } : kind === 'icon' ? { kind: 'icon', icon } : pictureUrl ? { kind: 'image', url: pictureUrl } : null;

  async function choose(file: File) {
    setPickFailure(null);
    setPreparing(true);
    try {
      const blob = await prepareAgentImage(file);
      if (!mounted.current) return;
      setPicked({ blob, url: URL.createObjectURL(blob) });
    } catch (raw) {
      setPickFailure(pickError(raw));
    } finally {
      setPreparing(false);
    }
  }

  async function save() {
    await run(async () => {
      const next = await adminApi.saveInterface({ agentMark: kind, agentIcon: icon, image: newPicture?.blob ?? null });
      setSaved(next);
      // A picture chosen while this one was saving stays the choice: it is not saved yet.
      if (newPicture) setPicked((current) => (current === newPicture ? null : current));
      await refresh();
    });
  }

  return (
    <Card className="rise">
      <CardHead title={t.markTitle} sub={t.markSub} />
      <div className={styles.body}>
        {/* A block around it: in the column the switch would stretch to the card's width. */}
        <div className={styles.kinds}>
          <Segmented label={t.kindLabel} options={KINDS.map((k) => ({ value: k, label: t.kinds[k] }))} value={kind} onChange={setKind} />
        </div>
        {kind === 'icon' ? <IconChoice value={icon} onChange={setIcon} /> : null}
        {kind === 'image' ? <PictureChoice url={pictureUrl} preparing={preparing} onFile={(file) => void choose(file)} /> : null}
        {kind === 'image' && pickFailure ? <ErrorBanner error={pickFailure} /> : null}
        {kind === 'none' ? <p className={section.sub}>{t.noneHint}</p> : null}
        <div>
          <div className={styles.samplesTitle}>{t.sampleTitle}</div>
          <div className={styles.samples}>
            <Sample mark={mark} theme="light" label={t.sampleLight} />
            <Sample mark={mark} theme="dark" label={t.sampleDark} />
          </div>
        </div>
        <Feedback error={error} />
        <div className={styles.foot}>
          <Button variant="primary" disabled={busy || preparing || !changed || !ready} onClick={() => void save()}>
            {t.save}
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function InterfaceSection() {
  const { state, reload } = useLoad(adminApi.interfaceSettings);
  return (
    <div className={cx(section.stack, styles.page)}>
      <PageHead title={t.title} lead={t.lead} />
      {state.status === 'loading' ? <Skeleton rows={4} /> : null}
      {state.status === 'error' ? <ErrorBanner error={state.error} onRetry={reload} /> : null}
      {state.status === 'ready' ? <AgentMarkForm initial={state.data} /> : null}
    </div>
  );
}
