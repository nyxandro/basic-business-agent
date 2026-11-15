// «Рассыпаться в песок» (decision of the owner 15.11), as messages vanish in Telegram: the element
// breaks into grains from its left edge to its right, and the wind carries them up and to the right
// until they fade. The element is drawn on a canvas by hand — background, border, text and icons,
// enough for a chip — in the colours it has now (so in either theme); each grain takes the colour of
// its pixel. The canvas lies over the page and goes with the last grain. The element is hidden at
// once: whoever removes it from the page does so on their own time.

// CSS px between grains, and the size of one.
const GRAIN = 2;
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
  color: string;
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
  clip: { x: number; y: number; w: number; h: number };
  ellipsis: boolean;
}

interface IconPiece {
  markup: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Picture {
  w: number;
  h: number;
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
    const clip = parent.getBoundingClientRect();
    texts.push({
      text,
      font: `${ps.fontStyle} ${ps.fontWeight} ${ps.fontSize} ${ps.fontFamily}`,
      color: ps.color,
      x: at.left - box.left,
      y: at.top - box.top + at.height / 2,
      clip: { x: clip.left - box.left, y: clip.top - box.top, w: clip.width, h: clip.height },
      ellipsis: ps.textOverflow === 'ellipsis',
    });
  }
  const icons = [...element.querySelectorAll('svg')].map((svg) => {
    const at = svg.getBoundingClientRect();
    const copy = svg.cloneNode(true) as SVGElement;
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('width', String(at.width));
    copy.setAttribute('height', String(at.height));
    // An icon drawn as a picture knows no CSS: its colour goes in as it is now.
    const markup = new XMLSerializer().serializeToString(copy).replaceAll('currentColor', getComputedStyle(svg).color);
    return { markup, x: at.left - box.left, y: at.top - box.top, w: at.width, h: at.height };
  });
  return {
    w: box.width,
    h: box.height,
    background: style.backgroundColor,
    borderColor: style.borderTopColor,
    borderWidth: parseFloat(style.borderTopWidth) || 0,
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
  for (const { image, icon } of images) ctx.drawImage(image, icon.x, icon.y, icon.w, icon.h);
  return canvas;
}

function grainsOf(canvas: HTMLCanvasElement, picture: Picture, dpr: number): Grain[] {
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  const { data, width } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const grains: Grain[] = [];
  for (let y = 0; y < picture.h; y += GRAIN) {
    for (let x = 0; x < picture.w; x += GRAIN) {
      const i = (Math.floor(y * dpr) * width + Math.floor(x * dpr)) * 4;
      const alpha = data[i + 3]!;
      if (alpha < 10) continue;
      // Up and to the right, each grain its own way.
      const angle = -Math.PI / 12 - Math.random() * (Math.PI * 5) / 12;
      const distance = DRIFT_PX * (0.35 + Math.random() * 0.65);
      grains.push({
        x,
        y,
        color: `rgba(${data[i]}, ${data[i + 1]}, ${data[i + 2]}, ${alpha / 255})`,
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

export async function dissolve(element: HTMLElement): Promise<void> {
  const box = element.getBoundingClientRect();
  const picture = pictureOf(element);
  element.style.visibility = 'hidden';
  const dpr = window.devicePixelRatio || 1;
  const snapshot = await draw(picture, dpr);
  if (!snapshot) return;
  const grains = grainsOf(snapshot, picture, dpr);

  const overlay = document.createElement('canvas');
  const w = picture.w + MARGIN_PX * 2;
  const h = picture.h + MARGIN_PX * 2;
  overlay.width = Math.ceil(w * dpr);
  overlay.height = Math.ceil(h * dpr);
  overlay.setAttribute('aria-hidden', 'true');
  Object.assign(overlay.style, { position: 'fixed', left: `${box.left - MARGIN_PX}px`, top: `${box.top - MARGIN_PX}px`, width: `${w}px`, height: `${h}px`, pointerEvents: 'none', zIndex: '1000' });
  const ctx = overlay.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  document.body.append(overlay);

  const total = SWEEP_MS + JITTER_MS + LIFE_MS.max;
  const started = performance.now();
  await new Promise<void>((done) => {
    const frame = (now: number) => {
      const t = now - started;
      ctx.clearRect(0, 0, w, h);
      // What the sweep has not reached yet is still the element itself.
      const front = Math.min(picture.w, (t / SWEEP_MS) * picture.w);
      if (front < picture.w) ctx.drawImage(snapshot, front * dpr, 0, (picture.w - front) * dpr, picture.h * dpr, MARGIN_PX + front, MARGIN_PX, picture.w - front, picture.h);
      for (const g of grains) {
        const age = t - g.delay;
        if (age >= g.life || (age < 0 && g.x >= front)) continue;
        const p = Math.max(0, age) / g.life;
        const e = easeOut(p);
        ctx.globalAlpha = (1 - p) ** 1.5;
        ctx.fillStyle = g.color;
        const size = GRAIN * (1 - p * 0.5);
        ctx.fillRect(MARGIN_PX + g.x + g.dx * e, MARGIN_PX + g.y + g.dy * e, size, size);
      }
      ctx.globalAlpha = 1;
      if (t < total) requestAnimationFrame(frame);
      else done();
    };
    requestAnimationFrame(frame);
  });
  overlay.remove();
}
