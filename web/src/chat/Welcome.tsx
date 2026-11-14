// An empty conversation (mockup): «Чем помочь, {имя}?», what the agent does, up to three questions
// to start with. A question leaves at once as the person's first message.
import type { AgentSummary } from '@bba/contracts';
import { useMe } from '../auth/session.tsx';
import { ru } from '../i18n/ru.ts';
import { Icon } from '../ui/Icon.tsx';
import styles from './chat.module.css';

const STARTERS_SHOWN = 3;

export function Welcome({ agent, onStart }: { agent: AgentSummary; onStart: (text: string) => void }) {
  const firstName = useMe().user.name.split(/\s+/)[0] ?? '';
  return (
    <div className={styles.welcome}>
      <div className={styles.welcomeMark}>
        <Icon name="spark" size={24} />
      </div>
      <h2 className={styles.welcomeTitle}>{ru.chat.greeting(firstName)}</h2>
      <p className={styles.welcomeText}>{agent.description}</p>
      {agent.starters.length > 0 ? (
        <div className={styles.starters}>
          {agent.starters.slice(0, STARTERS_SHOWN).map((s) => (
            <button key={s} type="button" className={styles.starter} onClick={() => onStart(s)}>
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
