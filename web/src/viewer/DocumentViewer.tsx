// The document viewer (spec, section 8.27; decisions of the owner 18.11): the whole screen, a thin bar —
// the name, «−», the scale, «+», «По ширине» (F23), «Скачать» beside «Закрыть» (F21) — and under it only
// the document, edge to edge. Word, Excel and PowerPoint the server turns into PDF first: a request of one
// byte starts it and brings back its refusal as a code and a text; PDF.js then reads the PDF in parts.
import { CONVERTED_KINDS, previewKindOf } from '@bba/contracts';
import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ApiRequestError, toError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import { Button, ButtonLink, cx, IconButton } from '../ui/Button.tsx';
import { useDialogFocus } from '../ui/dialog-focus.ts';
import { Icon } from '../ui/Icon.tsx';
import { DelayedBar } from '../ui/Loading.tsx';
import { ImageView, TextView } from './FileViews.tsx';
import type { ViewerFailure, ZoomControl } from './types.ts';
import { percent } from './zoom.ts';
import styles from './viewer.module.css';

export interface ViewerSource {
  name: string;
  // The file as it is: PDF, text, pictures and «Скачать».
  downloadUrl: string;
  // The PDF the server makes of Word, Excel and PowerPoint.
  previewUrl: string;
}

// PDF.js with its styles comes with the first PDF opened, not with the chat.
const PdfPages = lazy(() => import('./PdfPages.tsx'));

// Tried again with «Повторить»: what passes by itself.
const PASSING = new Set(['APP_PREVIEW_BUSY', 'APP_PREVIEW_TIMEOUT', 'APP_NETWORK_FAILED', 'APP_SERVER_UNAVAILABLE']);
// After this the person is told the document is being prepared, not only shown the bar.
const PREPARING_AFTER_MS = 3000;

// Starts the conversion and waits for it: the PDF is then in the server's cache for PDF.js.
async function prepare(url: string, signal: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { range: 'bytes=0-0' }, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiRequestError({ code: 'APP_NETWORK_FAILED', message: ru.clientErrors.APP_NETWORK_FAILED, status: 0, cause: error });
  }
  if (!res.ok) throw await toError(res);
  await res.body?.cancel();
}

function Content({ source, attempt, zoom, onScale, onReady, onFailure }: { source: ViewerSource; attempt: number; zoom: RefObject<ZoomControl | null>; onScale: (scale: number) => void; onReady: () => void; onFailure: (failure: ViewerFailure) => void }) {
  const kind = previewKindOf(source.name);
  const converted = kind !== null && CONVERTED_KINDS.has(kind);
  const [prepared, setPrepared] = useState(!converted);

  useEffect(() => {
    if (!converted) return;
    const stop = new AbortController();
    prepare(source.previewUrl, stop.signal).then(
      () => setPrepared(true),
      (error: unknown) => {
        if (stop.signal.aborted) return;
        const failure = error instanceof ApiRequestError ? error : new ApiRequestError({ code: 'APP_PREVIEW_FAILED', message: ru.clientErrors.APP_PREVIEW_FAILED, status: 0, cause: error });
        onFailure({ code: failure.code, message: failure.message });
      },
    );
    return () => stop.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.previewUrl, attempt]);

  if (!prepared) return null;
  const common = { zoom, onScale, onReady, onFailure };
  if (kind === 'text' || kind === 'markdown') return <TextView url={source.downloadUrl} markdown={kind === 'markdown'} {...common} />;
  if (kind === 'image') return <ImageView url={source.downloadUrl} name={source.name} {...common} />;
  return (
    <Suspense fallback={null}>
      <PdfPages url={converted ? source.previewUrl : source.downloadUrl} label={source.name} {...common} />
    </Suspense>
  );
}

export function DocumentViewer({ source, onClose }: { source: ViewerSource; onClose: () => void }) {
  const box = useDialogFocus(true, onClose);
  const zoom = useRef<ZoomControl | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | ViewerFailure>('loading');
  const [scale, setScale] = useState<number | null>(null);
  const [slow, setSlow] = useState(false);
  // A window over the dimmed page; the whole screen by the button (the first request of the owner, 18.11).
  const [wholeScreen, setWholeScreen] = useState(false);

  useEffect(() => {
    if (state !== 'loading') return;
    const timer = window.setTimeout(() => setSlow(true), PREPARING_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [state, attempt]);

  const retry = () => {
    setState('loading');
    setSlow(false);
    setAttempt((n) => n + 1);
  };

  const failure = typeof state === 'object' ? state : null;
  const ready = state === 'ready';

  // Ctrl/⌘ with «+», «−», «0» scale the document, not the page of the browser; Ctrl+K of the search does
  // not open the search under the viewer.
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const act = { '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut', '0': 'fit' }[event.key] as keyof ZoomControl | undefined;
    // The key itself, in any layout — as the search listens for it (layout/AppShell.tsx).
    if (event.code === 'KeyK') {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!act) return;
    event.preventDefault();
    event.stopPropagation();
    if (ready) zoom.current?.[act]();
  };

  return createPortal(
    <div className={cx(styles.layer, wholeScreen && styles.wholeScreen)}>
      {/* The dimmed page closes the viewer on a single click, as the other dialogs (ui/Modal.tsx). */}
      <button type="button" tabIndex={-1} aria-hidden="true" className={styles.scrim} onClick={(event) => event.detail <= 1 && onClose()} />
      <div ref={box} className={styles.window} role="dialog" aria-modal="true" aria-label={source.name} tabIndex={-1} onKeyDown={keys}>
        <div className={styles.bar}>
          <span className={styles.name} title={source.name}>
            {source.name}
          </span>
          <div className={styles.zoom} role="group" aria-label={ru.viewer.zoomGroup}>
            <IconButton icon="minus" size="sm" label={ru.viewer.zoomOut} disabled={!ready} onClick={() => zoom.current?.zoomOut()} />
            <span className={styles.percent} aria-live="polite" aria-label={scale === null ? undefined : ru.viewer.scale(percent(scale))}>
              {scale === null ? '' : percent(scale)}
            </span>
            <IconButton icon="plus" size="sm" label={ru.viewer.zoomIn} disabled={!ready} onClick={() => zoom.current?.zoomIn()} />
            <IconButton icon="fitWidth" size="sm" label={ru.viewer.fit} disabled={!ready} onClick={() => zoom.current?.fit()} />
          </div>
          <IconButton
            icon={wholeScreen ? 'collapse' : 'expand'}
            size="sm"
            label={wholeScreen ? ru.viewer.exitWholeScreen : ru.viewer.wholeScreen}
            className={styles.wholeScreenToggle}
            onClick={() => setWholeScreen((on) => !on)}
          />
          <ButtonLink href={source.downloadUrl} download={source.name} icon="download" size="sm" className={styles.download} aria-label={ru.viewer.download}>
            <span className={styles.downloadText}>{ru.viewer.download}</span>
          </ButtonLink>
          <IconButton icon="x" size="sm" label={ru.viewer.close} onClick={onClose} />
        </div>
        <div className={styles.body}>
          {state === 'loading' ? <DelayedBar /> : null}
          {state === 'loading' && slow ? <p className={styles.preparing}>{ru.viewer.preparing}</p> : null}
          {failure ? (
            <div className={styles.failure} role="alert">
              <Icon name="alert" size={22} />
              <p>{failure.message}</p>
              <p className={styles.code}>{failure.code}</p>
              <div className={styles.failureActions}>
                {PASSING.has(failure.code) ? (
                  <Button onClick={retry}>{ru.viewer.retry}</Button>
                ) : null}
                <ButtonLink href={source.downloadUrl} download={source.name} icon="download" variant="primary">
                  {ru.viewer.download}
                </ButtonLink>
              </div>
            </div>
          ) : (
            <Content
              key={attempt}
              source={source}
              attempt={attempt}
              zoom={zoom}
              onScale={setScale}
              onReady={() => setState('ready')}
              onFailure={(f) => setState(f)}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
