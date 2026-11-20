// «Рассыпаться в песок» (decision of the owner 15.11), as messages vanish in Telegram: the element
// breaks into grains from its left edge to its right, and the wind carries them up and to the right
// until they fade. The element is drawn on a canvas by hand — background, border, text and icons,
// enough for a chip — in the colours it has now (so in either theme); each grain takes the colour of
// its pixel. The canvas lies over the page and goes with the last grain. The element is hidden at
// once: whoever removes it from the page does so on their own time. The grains of a frame are written
// into one buffer of pixels and drawn at once: drawn one by one, a whole card of files (57 000 grains)
// took 80 ms a frame, through the buffer 4 ms (18.11, Chromium). The buffer is in CSS pixels, scaled up
// without smoothing: a grain looks the same, and a phone screen of density 3 needs 9 times less of it.

// CSS px between grains, and the size of one; an element larger than any card of files has larger
// grains, so that there are no more than MAX_GRAINS to draw in a frame.
const GRAIN = 2;
const MAX_GRAINS = 80000;
// The left edge starts at once, the right one this much later.
const SWEEP_MS = 380;
// A grain starts up to this much late, so the edge is ragged like sand, not a straight cut.
const JITTER_MS = 70;
const LIFE_MS = { min: 450, max: 800 };
// How far a grain flies at most, and the room around the element it may fly into.
const DRIFT_PX = 70;
const MARGIN_PX = 80;

interface Grain {
  x: number;
  y: number;
  // The colour of its pixel, 0–255.
  r: number;
  g: number;
  b: number;
  a: number;
  delay: number;
  life: number;
  dx: number;
  dy: number;
}

interface TextPiece {
  text: string;
  font: string;
  color: string;
  x: number;
  y: number;
  clip: Rect;
  ellipsis: boolean;
}

interface IconPiece {
  markup: string;
  x: number;
  y: number;
  w: number;
  h: number;
  clip: Rect;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// The part of a node seen in the element: within the boxes that clip what they hold up to the element
// (a list scrolled inside a card shows only some rows), in the element's own coordinates.
function seenRect(node: Element, element: HTMLElement): Rect {
  const box = element.getBoundingClientRect();
  let { left, top, right, bottom } = node.getBoundingClientRect();
  for (let holder = node.parentElement; holder && holder !== element.parentElement; holder = holder.parentElement) {
    const style = getComputedStyle(holder);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const at = holder.getBoundingClientRect();
    left = Math.max(left, at.left);
    top = Math.max(top, at.top);
    right = Math.min(right, at.right);
    bottom = Math.min(bottom, at.bottom);
  }
  return { x: left - box.left, y: top - box.top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

interface Size {
  w: number;
  h: number;
}

interface Picture extends Size {
  background: string;
  borderColor: string;
  borderWidth: number;
  radius: number;
  texts: TextPiece[];
  icons: IconPiece[];
}

// Everything the drawing needs, read while the element is still shown.
function pictureOf(element: HTMLElement): Picture {
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const texts: TextPiece[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const text = node.textContent?.trim();
    if (!parent || !text || parent.closest('svg')) continue;
    const ps = getComputedStyle(parent);
    const range = document.createRange();
    range.selectNodeContents(node);
    const at = range.getBoundingClientRect();
    // The text is cut by its own box (an ellipsis) and by what clips it.
    const clip = seenRect(parent, element);
    if (clip.w === 0 || clip.h === 0) continue;
    texts.push({
      text,
      font: `${ps.fontStyle} ${ps.fontWeight} ${ps.fontSize} ${ps.fontFamily}`,
      color: ps.color,
      x: at.left - box.left,
      y: at.top - box.top + at.height / 2,
      clip,
      ellipsis: ps.textOverflow === 'ellipsis',
    });
  }
  const icons = [...element.querySelectorAll('svg')].flatMap((svg) => {
    const clip = seenRect(svg, element);
    if (clip.w === 0 || clip.h === 0) return [];
    const at = svg.getBoundingClientRect();
    const copy = svg.cloneNode(true) as SVGElement;
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('width', String(at.width));
    copy.setAttribute('height', String(at.height));
    // An icon drawn as a picture knows no CSS: its colour goes in as it is now.
    const markup = new XMLSerializer().serializeToString(copy).replaceAll('currentColor', getComputedStyle(svg).color);
    return [{ markup, x: at.left - box.left, y: at.top - box.top, w: at.width, h: at.height, clip }];
  });
  // A border all round is part of the picture; a single line (between the rows of a list) is not.
  const sides = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map((v) => parseFloat(v) || 0);
  return {
    w: box.width,
    h: box.height,
    background: style.backgroundColor,
    borderColor: style.borderTopColor,
    borderWidth: sides.every((v) => v === sides[0]) ? sides[0]! : 0,
    radius: parseFloat(style.borderTopLeftRadius) || 0,
    texts,
    icons,
  };
}

function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let n = text.length;
  while (n > 0 && ctx.measureText(`${text.slice(0, n)}…`).width > width) n -= 1;
  return `${text.slice(0, n).trimEnd()}…`;
}

async function draw(picture: Picture, dpr: number): Promise<HTMLCanvasElement | null> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(picture.w * dpr);
  canvas.height = Math.ceil(picture.h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  const b = picture.borderWidth;
  ctx.beginPath();
  ctx.roundRect(b / 2, b / 2, picture.w - b, picture.h - b, picture.radius);
  ctx.fillStyle = picture.background;
  ctx.fill();
  if (b > 0) {
    ctx.lineWidth = b;
    ctx.strokeStyle = picture.borderColor;
    ctx.stroke();
  }
  for (const t of picture.texts) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(t.clip.x, t.clip.y, t.clip.w, t.clip.h);
    ctx.clip();
    ctx.font = t.font;
    ctx.fillStyle = t.color;
    ctx.textBaseline = 'middle';
    ctx.fillText(t.ellipsis ? fit(ctx, t.text, t.clip.x + t.clip.w - t.x) : t.text, t.x, t.y);
    ctx.restore();
  }
  const images = await Promise.all(
    picture.icons.map(async (icon) => {
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(icon.markup)}`;
      await image.decode();
      return { image, icon };
    }),
  );
  for (const { image, icon } of images) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(icon.clip.x, icon.clip.y, icon.clip.w, icon.clip.h);
    ctx.clip();
    ctx.drawImage(image, icon.x, icon.y, icon.w, icon.h);
    ctx.restore();
  }
  return canvas;
}

const grainOf = (picture: Size) => Math.max(GRAIN, Math.ceil(Math.sqrt((picture.w * picture.h) / MAX_GRAINS)));

function grainsOf(canvas: HTMLCanvasElement, picture: Size, dpr: number): Grain[] {
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  const { data, width } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const grains: Grain[] = [];
  const step = grainOf(picture);
  for (let y = 0; y < picture.h; y += step) {
    for (let x = 0; x < picture.w; x += step) {
      const i = (Math.floor(y * dpr) * width + Math.floor(x * dpr)) * 4;
      const alpha = data[i + 3]!;
      if (alpha < 10) continue;
      // Up and to the right, each grain its own way.
      const angle = -Math.PI / 12 - Math.random() * (Math.PI * 5) / 12;
      const distance = DRIFT_PX * (0.35 + Math.random() * 0.65);
      grains.push({
        x,
        y,
        r: data[i]!,
        g: data[i + 1]!,
        b: data[i + 2]!,
        a: alpha,
        delay: (x / picture.w) * SWEEP_MS + Math.random() * JITTER_MS,
        life: LIFE_MS.min + Math.random() * (LIFE_MS.max - LIFE_MS.min),
        dx: Math.cos(angle) * distance,
        dy: Math.sin(angle) * distance,
      });
    }
  }
  return grains;
}

const easeOut = (p: number) => 1 - (1 - p) ** 3;

// One grain, a square of pixels, into the frame; the frame is cleared each time, so nothing to blend.
function paint(pixels: Uint8ClampedArray, width: number, height: number, x0: number, y0: number, size: number, grain: Grain, alpha: number): void {
  for (let y = Math.max(0, y0); y < Math.min(height, y0 + size); y++) {
    for (let x = Math.max(0, x0); x < Math.min(width, x0 + size); x++) {
      const i = (y * width + x) * 4;
      pixels[i] = grain.r;
      pixels[i + 1] = grain.g;
      pixels[i + 2] = grain.b;
      pixels[i + 3] = alpha;
    }
  }
}

export async function dissolve(element: HTMLElement): Promise<void> {
  const box = element.getBoundingClientRect();
  const picture = pictureOf(element);
  element.style.visibility = 'hidden';
  const dpr = window.devicePixelRatio || 1;
  const snapshot = await draw(picture, dpr);
  if (!snapshot) return;
  await scatter(snapshot, box, picture, dpr);
}

// The grains of a drawn element fly from where it stood on the screen (`at`, CSS px).
async function scatter(snapshot: HTMLCanvasElement, box: { left: number; top: number }, picture: Size, dpr: number): Promise<void> {
  const grains = grainsOf(snapshot, picture, dpr);

  const overlay = document.createElement('canvas');
  const w = picture.w + MARGIN_PX * 2;
  const h = picture.h + MARGIN_PX * 2;
  overlay.width = Math.ceil(w * dpr);
  overlay.height = Math.ceil(h * dpr);
  overlay.setAttribute('aria-hidden', 'true');
  Object.assign(overlay.style, { position: 'fixed', left: `${box.left - MARGIN_PX}px`, top: `${box.top - MARGIN_PX}px`, width: `${w}px`, height: `${h}px`, pointerEvents: 'none', zIndex: '1000' });
  const ctx = overlay.getContext('2d');
  const layer = document.createElement('canvas');
  layer.width = Math.ceil(w);
  layer.height = Math.ceil(h);
  const grainLayer = layer.getContext('2d');
  if (!ctx || !grainLayer) return;
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = false;
  const frameImage = grainLayer.createImageData(layer.width, layer.height);
  const pixels = frameImage.data;
  document.body.append(overlay);

  const total = SWEEP_MS + JITTER_MS + LIFE_MS.max;
  const grain = grainOf(picture);
  const started = performance.now();
  await new Promise<void>((done) => {
    const frame = (now: number) => {
      const t = now - started;
      ctx.clearRect(0, 0, w, h);
      // What the sweep has not reached yet is still the element itself.
      const front = Math.min(picture.w, (t / SWEEP_MS) * picture.w);
      if (front < picture.w) ctx.drawImage(snapshot, front * dpr, 0, (picture.w - front) * dpr, picture.h * dpr, MARGIN_PX + front, MARGIN_PX, picture.w - front, picture.h);
      pixels.fill(0);
      for (const g of grains) {
        const age = t - g.delay;
        if (age >= g.life || (age < 0 && g.x >= front)) continue;
        const p = Math.max(0, age) / g.life;
        const e = easeOut(p);
        const size = Math.max(1, Math.round(grain * (1 - p * 0.5)));
        paint(pixels, layer.width, layer.height, Math.round(MARGIN_PX + g.x + g.dx * e), Math.round(MARGIN_PX + g.y + g.dy * e), size, g, Math.round(g.a * (1 - p) ** 1.5));
      }
      grainLayer.putImageData(frameImage, 0, 0);
      ctx.drawImage(layer, 0, 0, w, h);
      if (t < total) requestAnimationFrame(frame);
      else done();
    };
    requestAnimationFrame(frame);
  });
  overlay.remove();
}

// What the person removes turns to sand wherever it is (request of the owner 18.11): a file of the next
// message, alone or in its card, «Убрать все», a file of a project, a mark on a document (20.11). With
// «уменьшить движение» in the system it simply goes. The sand is only a picture: if it cannot be drawn, the thing
// still goes.
export const stillMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function turnToSand(element: HTMLElement | null): void {
  if (!element || stillMotion()) return;
  dissolve(element).catch((error: unknown) => console.warn('sand failed', error));
}

// What is not an HTML element of the kind `pictureOf` reads (a mark drawn in SVG over a page): its own picture as
// SVG markup, already in its colours, and where it stands on the screen (CSS px).
export function turnSvgToSand(markup: string, box: { left: number; top: number; w: number; h: number }): void {
  if (stillMotion()) return;
  const sand = async () => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    await image.decode();
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(box.w * dpr);
    canvas.height = Math.ceil(box.h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    await scatter(canvas, box, box, dpr);
  };
  sand().catch((error: unknown) => console.warn('sand failed', error));
}
