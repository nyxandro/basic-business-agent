// The peek of a picture (request of the owner 20.11): the mouse resting on a chip of a picture — of a sent message, of
// the input, of the card of many files — shows the picture in a small window over the chip. The picture is read only
// when its chip is first hovered, once for the life of the row; read as the viewer reads it (bytes and the type by the
// name), so GIF, WebP, SVG and BMP show too — the server gives a file of the conversation as a file to save. One
// listener on the row of chips: a chip only says it is a picture (`data-peek`). Not for a touch: a finger does not
// hover.
import { PREVIEW_MAX_BYTES, previewKindOf } from '@bba/contracts';
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ru } from '../i18n/ru.ts';
import { imageType, readCapped } from '../viewer/read.ts';
import { threadFileUrl } from './api.ts';
import styles from './attachments.module.css';

// A pass of the mouse over the row is not a wish to see: the window opens after the mouse rests this long.
const REST_MS = 250;
// The size of the window, and the room between it, its chip and the edges of the screen.
const PEEK_WIDTH = 280;
const GAP = 8;

type Picture = { state: 'loading' } | { state: 'ready'; src: string } | { state: 'failed' };

// Marks a chip of a picture for the peek; nothing for other files.
export function peekOf(name: string, path: string): { 'data-peek'?: string; 'data-peek-name'?: string } {
  return previewKindOf(name) === 'image' ? { 'data-peek': path, 'data-peek-name': name } : {};
}

export function useImagePeek(threadId: string | null): { bind: { onPointerOver: (event: PointerEvent) => void; onPointerOut: (event: PointerEvent) => void }; peek: ReactNode } {
  const [shown, setShown] = useState<{ path: string; name: string; at: DOMRect } | null>(null);
  const [pictures, setPictures] = useState<ReadonlyMap<string, Picture>>(new Map());
  const timer = useRef(0);
  const current = useRef<Element | null>(null);
  const reading = useRef(new Map<string, AbortController>());
  const made = useRef<string[]>([]);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      for (const stop of reading.current.values()) stop.abort();
      for (const src of made.current) URL.revokeObjectURL(src);
    },
    [],
  );

  const read = (path: string, name: string) => {
    if (!threadId || pictures.has(path) || reading.current.has(path)) return;
    const stop = new AbortController();
    reading.current.set(path, stop);
    setPictures((all) => new Map(all).set(path, { state: 'loading' }));
    readCapped(threadFileUrl(threadId, path), PREVIEW_MAX_BYTES, stop.signal).then(
      ({ bytes, cut }) => {
        reading.current.delete(path);
        if (cut) return setPictures((all) => new Map(all).set(path, { state: 'failed' }));
        const src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: imageType(name) }));
        made.current.push(src);
        setPictures((all) => new Map(all).set(path, { state: 'ready', src }));
      },
      () => {
        reading.current.delete(path);
        if (!stop.signal.aborted) setPictures((all) => new Map(all).set(path, { state: 'failed' }));
      },
    );
  };

  const hide = () => {
    window.clearTimeout(timer.current);
    current.current = null;
    setShown(null);
  };

  const bind = {
    onPointerOver: (event: PointerEvent) => {
      if (event.pointerType === 'touch' || !threadId) return;
      const chip = (event.target as Element).closest<HTMLElement>('[data-peek]');
      if (!chip || chip === current.current) return;
      hide();
      current.current = chip;
      const path = chip.dataset.peek!;
      const name = chip.dataset.peekName!;
      timer.current = window.setTimeout(() => {
        read(path, name);
        setShown({ path, name, at: chip.getBoundingClientRect() });
      }, REST_MS);
    },
    onPointerOut: (event: PointerEvent) => {
      const chip = current.current;
      // Moving between the parts of the same chip is not leaving it.
      if (chip && event.relatedTarget instanceof Node && chip.contains(event.relatedTarget)) return;
      if (chip) hide();
    },
  };

  const picture = shown ? pictures.get(shown.path) : undefined;
  const peek =
    shown && picture
      ? createPortal(
          <div
            className={styles.peek}
            aria-hidden={picture.state !== 'ready'}
            style={{
              left: Math.min(Math.max(GAP, shown.at.left + shown.at.width / 2 - PEEK_WIDTH / 2), window.innerWidth - PEEK_WIDTH - GAP),
              // Over the chip; under it when there is no room above.
              ...(shown.at.top > window.innerHeight / 3 ? { bottom: window.innerHeight - shown.at.top + GAP } : { top: shown.at.bottom + GAP }),
              width: PEEK_WIDTH,
            }}
          >
            {picture.state === 'ready' ? <img className={styles.peekImage} src={picture.src} alt={shown.name} /> : null}
            {picture.state === 'loading' ? <span className={styles.peekSpin} /> : null}
            {picture.state === 'failed' ? <span className={styles.peekNote}>{ru.chat.peekFailed}</span> : null}
          </div>,
          document.body,
        )
      : null;

  return { bind, peek };
}
