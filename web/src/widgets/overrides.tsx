// Our components in place of CopilotKit's standard ones where the theme alone does not give the look of the mockup
// (spec, section 8.31; mockup «Экраны агента»). The agent sees the same component with the same props. Where a prop
// is enough (no pill shapes, rows that wrap) the standard component draws with it; where the mockup has its own
// thing — the glass panel, the slider, the chart, the formula, a picture of our server only — ours draws.
import { standardUI, type GenerativeUIComponentProps } from '@copilotkit/react-core/generative-ui';
import { createContext, lazy, Suspense, useContext, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import { ru } from '../i18n/ru.ts';
import { ChartWidget, chartOf } from './chart.ts';
import { firstFailedCheck } from './checks.ts';
import styles from './widgets.module.css';

type Props<Name extends string> = GenerativeUIComponentProps<typeof standardUI, Name & Parameters<typeof standardUI.omit>[0][number]>;

// The standard component of a name: ours draws it with a prop changed or around it.
function standard(name: string): ComponentType<Record<string, unknown>> {
  const entry = standardUI.components.get(name);
  if (!entry) throw new Error(`CopilotKit has no standard component ${name}`);
  return entry.component as ComponentType<Record<string, unknown>>;
}

const StandardCard = standard('Card');
const StandardTitle = standard('Title');
const StandardButton = standard('Button');
const StandardRow = standard('Row');
const StandardBadge = standard('Badge');
const StandardTextField = standard('TextField');
const StandardSelect = standard('Select');
const StandardSegmentedControl = standard('SegmentedControl');
const StandardTable = standard('Table');
const StandardChart = standard('Chart');
const StandardEntityCard = standard('EntityCard');
const StandardImage = standard('Image');

// Inside the glass panel the buttons are white and clear, as on the file block (spec, section 8.18).
const OnGlass = createContext(false);

const PADDING: Record<string, string> = { sm: '12px', md: '16px', lg: '20px' };

function Card(props: Props<'Card'>) {
  if (props.background !== 'discovery-solid') return <StandardCard {...props} />;
  return (
    <OnGlass.Provider value>
      <div className={styles.glass} style={{ padding: `${PADDING[props.size ?? 'md']} ${PADDING[props.size ?? 'md']}` }}>
        {props.child}
        {props.children}
      </div>
    </OnGlass.Provider>
  );
}

function GlassButton(props: Props<'Button'>) {
  const blocked = firstFailedCheck(props.checks);
  const disabled = Boolean(props.disabled || props.loading || (blocked && blocked.severity !== 'warning' && blocked.severity !== 'info'));
  const className = props.variant === 'primary' ? styles.glassMain : styles.glassSecond;
  if (props.href) {
    return (
      <a className={className} href={props.href} target="_blank" rel="noopener noreferrer">
        {props.label ?? props.text}
      </a>
    );
  }
  return (
    <button
      className={className}
      type={props.submit ? 'submit' : 'button'}
      disabled={disabled}
      aria-busy={props.loading || undefined}
      onClick={(event) => {
        if (props.submit && event.currentTarget.form !== null) return;
        if (typeof props.copy === 'string') void navigator.clipboard.writeText(props.copy).catch(() => undefined);
        void props.onClick?.({});
      }}
    >
      {props.child ?? props.children ?? props.label ?? props.text}
    </button>
  );
}

function Button(props: Props<'Button'>) {
  if (useContext(OnGlass)) return <GlassButton {...props} />;
  return <StandardButton {...props} pill={props.pill ?? false} />;
}

// A title without a size is the title of a card of the mockup (15 px), not CopilotKit's larger one.
function Title(props: Props<'Title'>) {
  return <StandardTitle {...props} size={props.size ?? 'lg'} />;
}

// A row wraps when its children do not fit: buttons of a narrow card go to the next line, not past its edge.
function Row(props: Props<'Row'>) {
  return <StandardRow {...props} wrap={props.wrap ?? 'wrap'} />;
}

// A badge keeps its own width in a column: the status pill of the mockup, not a stripe.
function Badge(props: Props<'Badge'>) {
  return (
    <span className={styles.self}>
      <StandardBadge {...props} />
    </span>
  );
}

function TextField(props: Props<'TextField'>) {
  return <StandardTextField {...props} pill={props.pill ?? false} />;
}

function Select(props: Props<'Select'>) {
  return <StandardSelect {...props} pill={props.pill ?? false} />;
}

function SegmentedControl(props: Props<'SegmentedControl'>) {
  return <StandardSegmentedControl {...props} pill={props.pill ?? false} />;
}

// The slider of the mockup: a thin track filled with the accent up to the value, the value on the right of the label.
function Slider(props: Props<'Slider'>) {
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  const value = typeof props.value === 'number' ? props.value : min;
  const step = props.steps ? (max - min) / props.steps : (props.step ?? 1);
  const failed = firstFailedCheck(props.checks);
  const filled = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const shown = props.unit ? `${value} ${props.unit}` : String(value);
  return (
    <label className={styles.slider}>
      {(props.label || props.unit) && (
        <span className={styles.sliderHead}>
          <span className={styles.sliderLabel}>{props.label}</span>
          <span className={styles.sliderValue}>{shown}</span>
        </span>
      )}
      <input
        className={styles.range}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={props.disabled}
        name={props.name}
        style={{ '--fill': `${filled}%` } as CSSProperties}
        onChange={(event) => props.setValue?.(Number(event.target.value))}
      />
      {props.marks && props.marks.length > 0 && (
        <span className={styles.marks}>
          {props.marks.map((mark) => (
            <span key={mark.value} style={{ left: `${max > min ? ((mark.value - min) / (max - min)) * 100 : 0}%` }}>
              {mark.label ?? mark.value}
            </span>
          ))}
        </span>
      )}
      {failed && <span className={styles.check}>{failed.message}</span>}
    </label>
  );
}

// A table in its own frame with the header of the mockup's table of deals.
function Table(props: Props<'Table'>) {
  return (
    <div className={styles.table}>
      <StandardTable {...props} />
    </div>
  );
}

// The chart of the chat (web/src/genui/ChartBlock.tsx) for the kinds it draws; CopilotKit's for the rest.
function Chart(props: Props<'Chart'>) {
  const block = chartOf(props);
  if (!block) return <StandardChart {...props} />;
  return (
    <Suspense fallback={null}>
      <ChartWidget block={block} />
    </Suspense>
  );
}

// The recommended one on glass: an EntityCard with a badge of the accent colour (the rules of the agent say so).
function EntityCard(props: Props<'EntityCard'>) {
  if (props.badge?.color !== 'discovery') return <StandardEntityCard {...props} />;
  return (
    <div className={styles.glass} style={{ padding: '16px' }}>
      <div className={styles.glassHead}>
        <span className={styles.glassTitle}>{props.title}</span>
        <span className={styles.glassPill}>{props.badge.label}</span>
      </div>
      {props.subtitle && <span className={styles.glassMuted}>{props.subtitle}</span>}
      {props.meta && <span className={styles.glassMeta}>{props.meta}</span>}
      {props.description && <span>{props.description}</span>}
      {props.actions && props.actions.length > 0 && (
        <span className={styles.glassActions}>
          {props.actions.map((action, i) =>
            action.href ? (
              <a key={action.label} className={i === 0 ? styles.glassMain : styles.glassSecond} href={action.href} target="_blank" rel="noopener noreferrer">
                {action.label}
              </a>
            ) : (
              <button key={action.label} type="button" className={i === 0 ? styles.glassMain : styles.glassSecond} onClick={() => void props.onAction?.({ label: action.label })}>
                {action.label}
              </button>
            ),
          )}
        </span>
      )}
    </div>
  );
}

// Formulas are set by KaTeX, loaded with the first formula (spec, section 8.31).
const Formula = lazy(() => import('./Formula.tsx'));

function MathFormula(props: Props<'Math'>) {
  return (
    <Suspense fallback={<code>{props.value}</code>}>
      <Formula value={props.value} block={props.block === true} />
    </Suspense>
  );
}

// A picture only from our own server (decision of the owner 19.11, F36): another site's address is a link to open.
const ownAddress = (url: string): boolean => url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\');

function Image(props: Props<'Image'>) {
  if (typeof props.url === 'string' && ownAddress(props.url)) return <StandardImage {...props} />;
  return <ForeignPicture url={String(props.url ?? '')} />;
}

function ForeignPicture({ url }: { url: string }): ReactNode {
  let shown = url;
  try {
    const parsed = new URL(url);
    shown = `${parsed.host}${parsed.pathname}`;
  } catch {
    // Not an address at all: shown as written.
  }
  const safe = /^https?:\/\//.test(url);
  return safe ? (
    <a className={styles.picture} href={url} target="_blank" rel="noopener noreferrer">
      {ru.widgets.picture(shown)}
    </a>
  ) : (
    <span className={styles.picture}>{ru.widgets.picture(shown)}</span>
  );
}

export const widgetOverrides = {
  Card: { component: Card },
  Title: { component: Title },
  Button: { component: Button },
  Row: { component: Row },
  Badge: { component: Badge },
  TextField: { component: TextField },
  Select: { component: Select },
  SegmentedControl: { component: SegmentedControl },
  Slider: { component: Slider },
  Table: { component: Table },
  Chart: { component: Chart },
  EntityCard: { component: EntityCard },
  Math: { component: MathFormula },
  Image: { component: Image },
};
