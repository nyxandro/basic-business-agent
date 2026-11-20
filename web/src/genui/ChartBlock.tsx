// Bar, line and pie charts drawn as SVG: no chart library for three simple kinds. Colours come from
// the theme's series tokens in fixed order (dataviz: validated for colour-blind readers in both
// themes); identity never rests on colour alone — a legend, and a tooltip on every mark.
import type { ChartBlock } from '@bba/contracts';
import { useLayoutEffect, useRef, useState } from 'react';
import { ru } from '../i18n/ru.ts';
import styles from './genui.module.css';

// The drawing is as wide as its place, so the labels keep their size in a narrow column of a widget (spec, section
// 8.31); where the place cannot be measured (tests), the width of the chat.
const WIDTH = 560;
const MIN_WIDTH = 260;
const MAX_WIDTH = 900;

function useDrawingWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const measured = element.clientWidth;
      if (measured > 0) setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(measured))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
const HEIGHT = 220;
const PAD = { top: 12, right: 8, bottom: 28, left: 48 };
// The value over each bar (mockup «Экраны агента в разговоре»): for a chart of one series and few bars, with room for it.
const VALUE_BARS_MAX = 12;
const VALUE_ROOM = 14;
const writesValues = (block: ChartBlock): boolean => block.kind === 'bar' && block.series.length === 1 && block.labels.length <= VALUE_BARS_MAX;
const padOf = (block: ChartBlock) => (writesValues(block) ? { ...PAD, top: PAD.top + VALUE_ROOM } : PAD);
const PIE_RADIUS = 96;
const PIE_SLICES = 6;
const BAR_RADIUS = 4;
const BAR_GAP = 2;
const GRID = [0, 0.5, 1];

export const seriesColor = (i: number) => `var(--series-${i + 1})`;
const OTHER = 'var(--series-other)';
const formatValue = (v: number) => v.toLocaleString('ru-RU');

function Legend({ items }: { items: { name: string; color: string }[] }) {
  if (items.length < 2) return null;
  return (
    <ul className={styles.legend}>
      {items.map((it, i) => (
        <li key={i}>
          <span className={styles.swatch} style={{ background: it.color }} />
          {it.name}
        </li>
      ))}
    </ul>
  );
}

// A bar with its data end rounded and its base square on the axis.
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(BAR_RADIUS, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function Axes({ block, max, width }: { block: ChartBlock; max: number; width: number }) {
  const PAD = padOf(block);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const step = (width - PAD.left - PAD.right) / block.labels.length;
  // Long label lists keep every n-th label so they do not run into each other: about one label per 48 px.
  const every = Math.ceil(block.labels.length / Math.max(2, Math.min(12, Math.floor((width - PAD.left - PAD.right) / 48))));
  return (
    <g className={styles.axes}>
      {GRID.map((f) => (
        <g key={f}>
          <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + innerH * (1 - f)} y2={PAD.top + innerH * (1 - f)} />
          <text x={PAD.left - 8} y={PAD.top + innerH * (1 - f) + 4} textAnchor="end">
            {formatValue(Math.round(max * f))}
          </text>
        </g>
      ))}
      {block.labels.map((label, i) =>
        i % every === 0 ? (
          <text key={i} x={PAD.left + step * (i + 0.5)} y={HEIGHT - 8} textAnchor="middle">
            {label}
          </text>
        ) : null,
      )}
    </g>
  );
}

function BarsOrLines({ block, width }: { block: ChartBlock; width: number }) {
  const PAD = padOf(block);
  const valued = writesValues(block);
  const max = Math.max(1, ...block.series.flatMap((s) => s.values));
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const step = (width - PAD.left - PAD.right) / block.labels.length;
  const y = (v: number) => PAD.top + innerH * (1 - Math.max(0, v) / max);
  return (
    <svg viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={block.title ?? ru.genui.chart}>
      <Axes block={block} max={max} width={width} />
      {block.series.map((s, si) => {
        const color = seriesColor(si);
        if (block.kind === 'line') {
          const points = s.values.map((v, i) => `${PAD.left + step * (i + 0.5)},${y(v)}`).join(' ');
          return (
            <g key={si}>
              <polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {s.values.map((v, i) => (
                <circle key={i} cx={PAD.left + step * (i + 0.5)} cy={y(v)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2}>
                  <title>{`${s.name}, ${block.labels[i]}: ${formatValue(v)}`}</title>
                </circle>
              ))}
            </g>
          );
        }
        const group = step * 0.7;
        const barW = Math.max(2, group / block.series.length - BAR_GAP);
        return s.values.map((v, i) => {
          const x = PAD.left + step * i + (step - group) / 2 + (barW + BAR_GAP) * si;
          const h = PAD.top + innerH - y(v);
          const last = i === s.values.length - 1;
          return (
            <g key={`${si}-${i}`}>
              <path d={barPath(x, y(v), barW, h)} fill={color}>
                <title>{`${s.name}, ${block.labels[i]}: ${formatValue(v)}`}</title>
              </path>
              {valued && (
                <text x={x + barW / 2} y={y(v) - 5} textAnchor="middle" className={last ? styles.barValueLast : styles.barValue} data-bar-value={last ? 'last' : ''}>
                  {formatValue(v)}
                </text>
              )}
            </g>
          );
        });
      })}
    </svg>
  );
}

// More slices than colours: the smallest fold into «Другое».
export function pieSlices(block: ChartBlock): { label: string; value: number; color: string }[] {
  const all = block.labels.map((label, i) => ({ label, value: Math.max(0, block.series[0]!.values[i] ?? 0) }));
  if (all.length <= PIE_SLICES) return all.map((s, i) => ({ ...s, color: seriesColor(i) }));
  const sorted = [...all].sort((a, b) => b.value - a.value);
  const kept = sorted.slice(0, PIE_SLICES - 1).map((s, i) => ({ ...s, color: seriesColor(i) }));
  const other = sorted.slice(PIE_SLICES - 1).reduce((sum, s) => sum + s.value, 0);
  return [...kept, { label: ru.genui.other, value: other, color: OTHER }];
}

function Pie({ block }: { block: ChartBlock }) {
  const slices = pieSlices(block);
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  const c = PIE_RADIUS + 10;
  // Start of each slice, clockwise from the top.
  const starts = slices.map((_, i) => -Math.PI / 2 + (slices.slice(0, i).reduce((a, s) => a + s.value, 0) / total) * Math.PI * 2);
  return (
    <svg viewBox={`0 0 ${c * 2} ${c * 2}`} role="img" aria-label={block.title ?? ru.genui.chart} className={styles.pie}>
      {slices.map((s, i) => {
        const start = starts[i]!;
        const end = start + (s.value / total) * Math.PI * 2;
        const large = end - start > Math.PI ? 1 : 0;
        const [x1, y1, x2, y2] = [c + PIE_RADIUS * Math.cos(start), c + PIE_RADIUS * Math.sin(start), c + PIE_RADIUS * Math.cos(end), c + PIE_RADIUS * Math.sin(end)];
        const d = `M${c},${c} L${x1},${y1} A${PIE_RADIUS},${PIE_RADIUS} 0 ${large} 1 ${x2},${y2} Z`;
        return (
          <path key={i} d={d} fill={s.color} stroke="var(--surface)" strokeWidth={2}>
            <title>{`${s.label}: ${formatValue(s.value)}`}</title>
          </path>
        );
      })}
    </svg>
  );
}

export function ChartBlockView({ block }: { block: ChartBlock }) {
  const [place, width] = useDrawingWidth();
  const legend = block.kind === 'pie' ? pieSlices(block).map((s) => ({ name: s.label, color: s.color })) : block.series.map((s, i) => ({ name: s.name, color: seriesColor(i) }));
  return (
    <figure className={styles.block}>
      {block.title ? <figcaption className={styles.caption}>{block.title}</figcaption> : null}
      <div className={styles.chart} ref={place}>
        {block.kind === 'pie' ? <Pie block={block} /> : <BarsOrLines block={block} width={width} />}
        <Legend items={legend} />
      </div>
    </figure>
  );
}
