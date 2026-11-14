// «Пустая установка» (spec, section 7): until the admin adds a model the agents cannot answer.
// An employee sees why instead of the input; the superadmin is sent to set the models up.
import { Link } from 'react-router';
import { useMe } from '../auth/session.tsx';
import { ru } from '../i18n/ru.ts';
import { IconTile } from '../ui/Display.tsx';
import styles from './shell.module.css';

// Where the superadmin sets the models up («Нейросеть» of the admin panel).
export const MODELS_PATH = '/admin';

export function EmptyInstallation() {
  const me = useMe();
  return (
    <div className={styles.notice} role="status">
      <IconTile icon="cpu" size={52} solid />
      <p className={styles.noticeTitle}>{me.isSuperadmin ? ru.shell.modelsMissingAdmin : ru.shell.modelsMissing}</p>
      {me.isSuperadmin ? (
        <p className={styles.noticeText}>
          <Link to={MODELS_PATH}>{ru.shell.toModels}</Link>
        </p>
      ) : null}
    </div>
  );
}
