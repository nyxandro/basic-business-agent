// What to ask next (spec, section 8.31; mockup «Экраны агента: набор компонентов», № 67): pills at the end of a
// screen; a press sends the words as the person's message, like the suggestions of an empty chat. Ours in place of
// CopilotKit's: the pill the person pressed stays marked by colour and a tick, and once the person answered the pills
// are inactive (owner 20.11, as with a choice of the chat, 16.11). A press while the agent answers is not sent: the
// block says to press again (busy.tsx). When the model bound `onFollowUp`, that binding sends, as in CopilotKit's.
import { useAgent, useCopilotKit } from '@copilotkit/react-core';
import type { GenerativeUIComponentProps, standardUI } from '@copilotkit/react-core/generative-ui';
import { useContext, useRef, type ReactNode } from 'react';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import { BusyPress, useBusyGuard } from './busy.tsx';
import { WidgetReplyContext } from './reply.ts';
import styles from './widgets.module.css';

type Props = GenerativeUIComponentProps<typeof standardUI, 'FollowUp'>;

export function FollowUp(props: Props): ReactNode {
  const { answered, chosen } = useContext(WidgetReplyContext);
  const busy = useContext(BusyPress);
  const { agent } = useAgent();
  const { copilotkit } = useCopilotKit();
  const bound = useBusyGuard(props.onFollowUp);
  // The second click of a double click is not a second message.
  const going = useRef(false);
  const items = (props.items ?? []).map((item) => (typeof item === 'string' ? { label: item, message: item } : { label: item.label, message: item.message ?? item.label }));
  if (items.length === 0) return null;

  const send = async (message: string) => {
    if (bound) {
      await bound({ message });
      return;
    }
    if (going.current) return;
    if (agent.isRunning) {
      busy?.();
      return;
    }
    going.current = true;
    try {
      agent.addMessage({ id: crypto.randomUUID(), role: 'user', content: message });
      await copilotkit.runAgent({ agent });
    } finally {
      going.current = false;
    }
  };

  return (
    <div className={styles.followUps}>
      {props.title && <span className={styles.followUpsTitle}>{props.title}</span>}
      <div className={styles.followUpRow}>
        {items.map((item, i) => {
          const isChosen = answered && (chosen.has(item.message) || chosen.has(item.label));
          return (
            <button key={`${item.label}-${i}`} type="button" className={cx(styles.followUp, isChosen && styles.chosen)} disabled={answered} data-chosen={isChosen || undefined} onClick={() => void send(item.message)}>
              {isChosen ? <Icon name="check" size={15} /> : null}
              {item.label}
              {isChosen ? <span className="visually-hidden">{ru.genui.chosen}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
