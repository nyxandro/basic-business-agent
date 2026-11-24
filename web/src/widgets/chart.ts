// A chart of a widget drawn by the chart of the chat (web/src/genui/ChartBlock.tsx, the look of the mockup) when it is
// one the chart of the chat draws: bars, a line (an area too) or a circle (a donut too), up to six series, numbers.
// Anything else — scatter, stacked, more series — stays CopilotKit's (spec, section 8.31).
import { CHART_SERIES_MAX, chartBlockSchema, type ChartBlock } from '@bba/contracts';
import { lazy } from 'react';

// The chart of the chat is loaded with the first chart, as in the chat (web/src/chat/renderers.tsx).
export const ChartWidget = lazy(() => import('../genui/ChartBlock.tsx').then((m) => ({ default: m.ChartBlockView })));

interface WidgetChart {
  chartType?: string;
  data?: Record<string, unknown>[];
  xKey?: string;
  series?: (string | { key: string; label?: string })[];
  stacked?: boolean;
  layout?: string;
  title?: string;
}

const KIND: Record<string, ChartBlock['kind']> = { bar: 'bar', line: 'line', area: 'line', pie: 'pie', donut: 'pie' };

const labelOf = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

export function chartOf(props: WidgetChart): ChartBlock | null {
  const kind = KIND[props.chartType ?? 'bar'];
  const data = props.data ?? [];
  const xKey = props.xKey;
  if (!kind || props.stacked || props.layout === 'horizontal' || !xKey || data.length === 0) return null;
  const keys = (props.series ?? Object.keys(data[0] ?? {}).filter((k) => k !== xKey && typeof data[0]?.[k] === 'number')).map((s) => (typeof s === 'string' ? { key: s, label: s } : { key: s.key, label: s.label ?? s.key }));
  if (keys.length === 0 || keys.length > CHART_SERIES_MAX || (kind === 'pie' && keys.length !== 1)) return null;
  const parsed = chartBlockSchema.safeParse({
    title: props.title,
    kind,
    labels: data.map((row) => labelOf(row[xKey])),
    series: keys.map((s) => ({ name: s.label, values: data.map((row) => Number(row[s.key])) })),
  });
  return parsed.success && parsed.data.series.every((s) => s.values.every(Number.isFinite)) ? parsed.data : null;
}
