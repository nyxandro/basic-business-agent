// The agent's mark (spec, section 8.17): the icon or the picture set on the agent's page, next to its
// words, its «думает…», its question and on the welcome of a new conversation. Each agent has its
// own (decision of the owner 16.11); with «Показывать значок агента в чате» off in «Интерфейс» there
// is nothing, and the words start at the left edge.
import type { AgentMark as Mark } from '@bba/contracts';
import { useMe } from '../auth/session.tsx';
import { cx } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import styles from './agent-mark.module.css';
import { useChatExtras } from '../answer/chat-context.ts';

type Size = 'small' | 'large';
const ICON_SIZE: Record<Size, number> = { small: 16, large: 24 };

export function AgentMarkView({ mark, size = 'small', className }: { mark: Mark; size?: Size; className?: string }) {
  return (
    <span
      className={cx(styles.mark, styles[size], mark.kind === 'image' ? styles.picture : styles.icon, className)}
      aria-hidden="true"
      data-agent-mark={mark.kind}
      {...(mark.kind === 'icon' ? { 'data-icon': mark.icon } : {})}
    >
      {/* alt="" — decorative: a picture that did not load leaves an empty circle, not a broken-image sign. */}
      {mark.kind === 'image' ? <img src={mark.url} alt="" className={styles.img} draggable={false} /> : <Icon name={mark.icon} size={ICON_SIZE[size]} />}
    </span>
  );
}

// The mark of the conversation's agent, as the chat draws it.
export function AgentMark({ size, className }: { size?: Size; className?: string }) {
  const show = useMe().interface.showAgentMark;
  const { agent } = useChatExtras();
  if (!show) return null;
  return <AgentMarkView mark={agent.mark} {...(size ? { size } : {})} {...(className ? { className } : {})} />;
}
