// An empty conversation (mockup): «Чем помочь, {имя}?» and what the agent does. No questions to start with: the owner
// removed them on 24.11 («никаких подсказок в пустом чате не нужно»).
import type { AgentSummary } from '@bba/contracts';
import { useMe } from '../auth/session.tsx';
import { ru } from '../i18n/ru.ts';
import { AgentMark } from './AgentMark.tsx';
import styles from './chat.module.css';

export function Welcome({ agent }: { agent: AgentSummary }) {
  const firstName = useMe().user.name.split(/\s+/)[0] ?? '';
  return (
    <div className={styles.welcome}>
      <AgentMark size="large" className={styles.welcomeMark} />
      <h2 className={styles.welcomeTitle}>{ru.chat.greeting(firstName)}</h2>
      <p className={styles.welcomeText}>{agent.description}</p>
    </div>
  );
}
