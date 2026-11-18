// The scale of the document viewer (spec, section 8.27; decision of the owner 18.11 — F23: the reset fits
// the document to the width). «−» and «+» go by steps; the reset fits the page to the width, on a wide
// screen no bigger than 150 % — otherwise a portrait page has letters the size of the screen. Two fingers
// on a touch screen scale freely between the limits.

export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;
export const ZOOM_MIN = ZOOM_STEPS[0];
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
export const FIT_MAX = 1.5;
// A scale this close to a step is that step: «+» goes to the next one.
const SAME = 0.005;

export const clampZoom = (scale: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));

export function zoomIn(scale: number): number {
  return ZOOM_STEPS.find((step) => step > scale + SAME) ?? ZOOM_MAX;
}

export function zoomOut(scale: number): number {
  return [...ZOOM_STEPS].reverse().find((step) => step < scale - SAME) ?? ZOOM_MIN;
}

// The scale at which a page `pageWidth` wide (at 100 %) fills `space`.
export function fitScale(space: number, pageWidth: number): number {
  return clampZoom(Math.min(space / pageWidth, FIT_MAX));
}

export const percent = (scale: number): string => `${Math.round(scale * 100)} %`;

// How much the distance between the fingers must change to be a gesture rather than a tremble.
const PINCH_DEAD_ZONE = 0.02;

// Two fingers scale the document (Pointer Events: a touch screen and a touch pad alike); one finger
// scrolls as usual. One new scale a frame, however often the fingers move.
export function attachPinch(container: HTMLElement, { read, apply }: { read: () => number; apply: (scale: number) => void }): () => void {
  const fingers = new Map<number, { x: number; y: number }>();
  let startDistance = 0;
  let startScale = 1;
  let wanted: number | null = null;
  let frame = 0;
  const distance = () => {
    const [a, b] = [...fingers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (fingers.size === 2) {
      startDistance = distance();
      startScale = read();
    }
  };
  const move = (event: PointerEvent) => {
    if (!fingers.has(event.pointerId)) return;
    fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (fingers.size !== 2 || startDistance === 0) return;
    const ratio = distance() / startDistance;
    if (Math.abs(ratio - 1) < PINCH_DEAD_ZONE) return;
    // While the fingers scale, the page does not scroll from under them.
    event.preventDefault();
    wanted = clampZoom(startScale * ratio);
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      if (wanted !== null) apply(wanted);
    });
  };
  const up = (event: PointerEvent) => {
    fingers.delete(event.pointerId);
    if (fingers.size < 2) startDistance = 0;
  };
  // Safari's own pinch of the whole page.
  const noPageZoom = (event: Event) => event.preventDefault();
  container.addEventListener('pointerdown', down);
  // Not passive: otherwise preventDefault of a move is ignored.
  container.addEventListener('pointermove', move, { passive: false });
  container.addEventListener('pointerup', up);
  container.addEventListener('pointercancel', up);
  container.addEventListener('gesturestart', noPageZoom);
  container.addEventListener('gesturechange', noPageZoom);
  return () => {
    container.removeEventListener('pointerdown', down);
    container.removeEventListener('pointermove', move);
    container.removeEventListener('pointerup', up);
    container.removeEventListener('pointercancel', up);
    container.removeEventListener('gesturestart', noPageZoom);
    container.removeEventListener('gesturechange', noPageZoom);
    cancelAnimationFrame(frame);
    fingers.clear();
  };
}
