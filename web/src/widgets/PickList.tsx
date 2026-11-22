// A list the person picks from (spec, section 8.31; issue #23). CopilotKit's List and ListItem send a message with an
// `action` event; ours wrap them the way the buttons are wrapped: a pick CopilotKit drops while the agent is answering
// tells the block (busy.tsx), a second pick while the first is going is not made, and once the person answered the items
// that send are inactive and the picked one is marked by colour and a tick — the one picked in this window, or the one
// the answer names (reply.ts). An item that only opens an address keeps working. A list without a pick is CopilotKit's
// as it is.
import { standardUI, type GenerativeUIComponentProps } from '@copilotkit/react-core/generative-ui';
import { useContext, useState, type ComponentType, type ReactNode } from 'react';
import { ru } from '../i18n/ru.ts';
import { Icon } from '../ui/Icon.tsx';
import { useBusyGuard } from './busy.tsx';
import { WidgetReplyContext } from './reply.ts';
import styles from './widgets.module.css';

type ListProps = GenerativeUIComponentProps<typeof standardUI, 'List'>;
type ListItemProps = GenerativeUIComponentProps<typeof standardUI, 'ListItem'>;
type Outcome = { ok: boolean } | undefined;

function standard(name: string): ComponentType<Record<string, unknown>> {
  const entry = standardUI.components.get(name);
  if (!entry) throw new Error(`CopilotKit has no standard component ${name}`);
  return entry.component as ComponentType<Record<string, unknown>>;
}
const StandardList = standard('List');
const StandardListItem = standard('ListItem');

// CopilotKit draws the label of an item as it is given (ItemBody), so the mark goes into the label.
function Picked({ words }: { words: string }): ReactNode {
  return (
    <span className={styles.picked} data-chosen>
      <Icon name="check" size={15} />
      {words}
      <span className="visually-hidden">{ru.genui.chosen}</span>
    </span>
  );
}

const entryOf = (item: unknown): Record<string, unknown> => (typeof item === 'string' ? { label: item } : (item as Record<string, unknown>));

export function List(props: ListProps): ReactNode {
  const { answered, chosen, sending, sendsUnnamed } = useContext(WidgetReplyContext);
  const [picked, setPicked] = useState<number | null>(null);
  const guarded = useBusyGuard(props.action as ((args: { index: number }) => Promise<Outcome>) | undefined);
  const items = (props.items ?? []).map(entryOf);
  if (!guarded || items.length === 0) return <StandardList {...props} />;
  const labels = items.map((item) => (typeof item.label === 'string' ? item.label : ''));
  const sends = sendsUnnamed || labels.some((label) => sending.has(label));
  if (!answered || !sends) {
    const action = async (args: { index: number }) => {
      setPicked(args.index);
      const outcome = await guarded(args);
      if (!outcome?.ok) setPicked(null);
      return outcome;
    };
    return <StandardList {...props} action={action} />;
  }
  // Answered: no item picks any more; the value is the payload of a pick, not shown (CopilotKit's List hides it too).
  const done = items.map(({ value: _value, ...item }, index) => ({
    ...item,
    label: picked === index || chosen.has(labels[index]!) ? <Picked words={labels[index]!} /> : <span className={styles.pickOff}>{labels[index]}</span>,
  }));
  return <StandardList {...props} items={done} action={undefined} />;
}

export function ListItem(props: ListItemProps): ReactNode {
  const { answered, chosen, sending, sendsUnnamed } = useContext(WidgetReplyContext);
  const [picked, setPicked] = useState(false);
  const guarded = useBusyGuard(props.action as ((args: Record<string, never>) => Promise<Outcome>) | undefined);
  if (!guarded) return <StandardListItem {...props} />;
  const words = typeof props.label === 'string' ? props.label : null;
  const sends = sendsUnnamed || (words !== null && sending.has(words));
  if (!answered || !sends) {
    const action = async (args: Record<string, never>) => {
      setPicked(true);
      const outcome = await guarded(args);
      if (!outcome?.ok) setPicked(false);
      return outcome;
    };
    return <StandardListItem {...props} action={action} />;
  }
  if (words !== null && (picked || chosen.has(words))) return <StandardListItem {...props} label={<Picked words={words} />} value={undefined} action={undefined} />;
  return <StandardListItem {...props} value={undefined} disabled />;
}
