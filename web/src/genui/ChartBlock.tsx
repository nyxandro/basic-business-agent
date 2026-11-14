// Bar, line and pie charts drawn as SVG: no chart library for three simple kinds.
import type { ChartBlock } from '@bba/contracts';

const WIDTH = 520;
const HEIGHT = 240;
const PAD = { top: 12, right: 12, bottom: 28, left: 44 };
const PIE_RADIUS = 100;
// Series colours: distinct in both themes, the same order as the legend.
const COLORS = ['#2b6cdf', '#e0782d', '#2f9e6b', '#b5489b', '#8a6d1f', '#4b8fa8', '#c2423f', '#6e5bd1'];

const formatValue = (v: number) => v.toLocaleString('ru-RU');

function Legend({ items }: { items: string[] }) {
  return (
    <ul className="genui-legend">
      {items.map((name, i) => (
        <li key={i}>
          <span className="genui-swatch" style={{ background: COLORS[i % COLORS.length] }} />
          {name}
        </li>
      ))}
    </ul>
  );
}

function Axes({ block, max }: { block: ChartBlock; max: number }) {
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const step = (WIDTH - PAD.left - PAD.right) / block.labels.length;
  return (
    <g className="genui-axes">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={PAD.left} x2={WIDTH - PAD.right} y1={PAD.top + innerH * (1 - f)} y2={PAD.top + innerH * (1 - f)} />
          <text x={PAD.left - 6} y={PAD.top + innerH * (1 - f) + 4} textAnchor="end">
            {formatValue(Math.round(max * f))}
          </text>
        </g>
      ))}
      {block.labels.map((label, i) => (
        <text key={i} x={PAD.left + step * (i + 0.5)} y={HEIGHT - 8} textAnchor="middle">
          {label}
        </text>
      ))}
    </g>
  );
}

function BarsOrLines({ block }: { block: ChartBlock }) {
  const max = Math.max(1, ...block.series.flatMap((s) => s.values));
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const step = (WIDTH - PAD.left - PAD.right) / block.labels.length;
  const y = (v: number) => PAD.top + innerH * (1 - Math.max(0, v) / max);
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={block.title ?? ''}>
      <Axes block={block} max={max} />
      {block.series.map((s, si) => {
        const color = COLORS[si % COLORS.length];
        if (block.kind === 'line') {
          const points = s.values.map((v, i) => `${PAD.left + step * (i + 0.5)},${y(v)}`).join(' ');
          return <polyline key={si} points={points} fill="none" stroke={color} strokeWidth={2} />;
        }
        const barW = (step * 0.7) / block.series.length;
        return s.values.map((v, i) => (
          <rect key={`${si}-${i}`} x={PAD.left + step * i + step * 0.15 + barW * si} y={y(v)} width={barW} height={PAD.top + innerH - y(v)} fill={color}>
            <title>{`${s.name}, ${block.labels[i]}: ${formatValue(v)}`}</title>
          </rect>
        ));
      })}
    </svg>
  );
}

function Pie({ block }: { block: ChartBlock }) {
  const values = block.series[0]!.values.map((v) => Math.max(0, v));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const c = PIE_RADIUS + 10;
  // Start and end angle of each slice, clockwise from the top.
  const slices = values.map((v, i) => {
    const start = -Math.PI / 2 + (values.slice(0, i).reduce((a, b) => a + b, 0) / total) * Math.PI * 2;
    return { v, start, end: start + (v / total) * Math.PI * 2 };
  });
  return (
    <svg viewBox={`0 0 ${c * 2} ${c * 2}`} role="img" aria-label={block.title ?? ''} className="genui-pie">
      {slices.map(({ v, start, end }, i) => {
        const large = end - start > Math.PI ? 1 : 0;
        const [x1, y1, x2, y2] = [c + PIE_RADIUS * Math.cos(start), c + PIE_RADIUS * Math.sin(start), c + PIE_RADIUS * Math.cos(end), c + PIE_RADIUS * Math.sin(end)];
        return (
          <path key={i} d={`M${c},${c} L${x1},${y1} A${PIE_RADIUS},${PIE_RADIUS} 0 ${large} 1 ${x2},${y2} Z`} fill={COLORS[i % COLORS.length]}>
            <title>{`${block.labels[i]}: ${formatValue(v)}`}</title>
          </path>
        );
      })}
    </svg>
  );
}

export function ChartBlockView({ block }: { block: ChartBlock }) {
  return (
    <figure className="genui genui-chart">
      {block.title ? <figcaption>{block.title}</figcaption> : null}
      {block.kind === 'pie' ? <Pie block={block} /> : <BarsOrLines block={block} />}
      <Legend items={block.kind === 'pie' ? block.labels : block.series.map((s) => s.name)} />
    </figure>
  );
}
