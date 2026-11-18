// Text, Markdown and pictures in the viewer (spec, section 8.27): read by the browser up to the limit,
// scaled by the same «−», «+» and reset as the pages of a PDF.
import { PREVIEW_MAX_BYTES, PREVIEW_TEXT_MAX_BYTES } from '@bba/contracts';
import { StreamingMarkdownDefaultRenderer } from '@copilotkit/react-core';
import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState, type ComponentProps, type CSSProperties, type Ref, type RefObject } from 'react';
import { asApiError } from '../api/client.ts';
import { ru } from '../i18n/ru.ts';
import type { ViewerFailure, ZoomControl } from './types.ts';
import { imageType, readCapped } from './read.ts';
import { decodeText } from './text.ts';
import { attachPinch, clampZoom, fitScale, zoomIn, zoomOut } from './zoom.ts';
import styles from './viewer.module.css';

interface ViewProps {
  url: string;
  zoom: Ref<ZoomControl>;
  onScale: (scale: number) => void;
  onReady: () => void;
  onFailure: (failure: ViewerFailure) => void;
}

// Two fingers scale text and pictures as they do the pages of a PDF (zoom.ts).
function usePinch(box: RefObject<HTMLDivElement | null>, scale: number, set: (scale: number) => void) {
  const read = useEffectEvent(() => scale);
  const apply = useEffectEvent((next: number) => set(next));
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    return attachPinch(node, { read: () => read(), apply: (next) => apply(next) });
  }, [box]);
}

const failureOf = (error: unknown): ViewerFailure => {
  const failure = asApiError(error);
  return { code: failure.code, message: failure.message };
};

// A picture of Markdown is never loaded — from the internet the request itself would carry the person's data
// out, whatever the address looks like (`//host`, a space, angle brackets): only its description is shown.
const NO_PICTURES: NonNullable<ComponentProps<typeof StreamingMarkdownDefaultRenderer>['nodeRenderers']> = {
  image: ({ node }) => <span className={styles.imageNote}>{ru.viewer.imageNotShown(node.alt)}</span>,
};

export function TextView({ url, markdown, zoom, onScale, onReady, onFailure }: ViewProps & { markdown: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [read, setRead] = useState<{ text: string; cut: boolean } | null>(null);
  const [scale, setScale] = useState(1);
  const set = (next: number) => {
    setScale(clampZoom(next));
    onScale(clampZoom(next));
  };
  usePinch(box, scale, set);
  // Text is fitted at its own size: the reset is 100 %.
  useImperativeHandle(zoom, () => ({ zoomIn: () => set(zoomIn(scale)), zoomOut: () => set(zoomOut(scale)), fit: () => set(1) }));

  useEffect(() => {
    const stop = new AbortController();
    readCapped(url, PREVIEW_TEXT_MAX_BYTES, stop.signal).then(
      ({ bytes, cut }) => {
        setRead({ text: decodeText(bytes, cut), cut });
        onScale(1);
        onReady();
      },
      (error: unknown) => {
        if (!stop.signal.aborted) onFailure(failureOf(error));
      },
    );
    return () => stop.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return (
    <div ref={box} className={styles.text} style={{ '--viewer-scale': scale } as CSSProperties} tabIndex={0} hidden={!read}>
      {read?.cut ? <p className={styles.cut}>{ru.viewer.textCut}</p> : null}
      {!read ? null : markdown ? <StreamingMarkdownDefaultRenderer content={read.text} isStreaming={false} className={styles.markdown} nodeRenderers={NO_PICTURES} /> : <pre className={styles.plain}>{read.text}</pre>}
    </div>
  );
}

export function ImageView({ url, name, zoom, onScale, onReady, onFailure }: ViewProps & { name: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [natural, setNatural] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const set = (next: number) => {
    setScale(clampZoom(next));
    onScale(clampZoom(next));
  };
  const fit = (width = natural) => {
    if (width && box.current) set(fitScale(box.current.clientWidth, width));
  };
  usePinch(box, scale, set);
  useImperativeHandle(zoom, () => ({ zoomIn: () => set(zoomIn(scale)), zoomOut: () => set(zoomOut(scale)), fit: () => fit() }));

  useEffect(() => {
    const stop = new AbortController();
    let made: string | null = null;
    readCapped(url, PREVIEW_MAX_BYTES, stop.signal).then(
      ({ bytes, cut }) => {
        if (cut) return onFailure({ code: 'APP_PREVIEW_TOO_BIG', message: ru.clientErrors.APP_PREVIEW_TOO_BIG });
        // Of the bytes, with the type by the name: an SVG in <img> runs no scripts.
        made = URL.createObjectURL(new Blob([bytes as BlobPart], { type: imageType(name) }));
        setSrc(made);
      },
      (error: unknown) => {
        if (!stop.signal.aborted) onFailure(failureOf(error));
      },
    );
    return () => {
      stop.abort();
      if (made) URL.revokeObjectURL(made);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, name]);

  return (
    <div ref={box} className={styles.image} tabIndex={0}>
      {src ? (
        <img
          src={src}
          alt={name}
          style={natural ? { width: natural * scale } : undefined}
          onLoad={(event) => {
            const width = event.currentTarget.naturalWidth;
            setNatural(width);
            fit(width);
            onReady();
          }}
          onError={() => onFailure({ code: 'APP_PREVIEW_FAILED', message: ru.clientErrors.APP_PREVIEW_FAILED })}
        />
      ) : null}
    </div>
  );
}
