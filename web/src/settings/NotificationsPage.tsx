// «Настройки → Уведомления» (docs/specs/[20.11.2026]-notifications.md, scenario 1): notifications of this browser —
// turn on, check, turn off — and the quiet night. Each device is turned on by itself.
import { notificationTexts as t } from '../i18n/notifications.ts';
import { PageFrame } from '../layout/PageFrame.tsx';
import { PushSettings } from '../notifications/PushControls.tsx';
import { Card, CardHead } from '../ui/Display.tsx';
import styles from '../notifications/notifications.module.css';

export function NotificationsPage() {
  return (
    <PageFrame title={t.settingsTitle} lead={t.settingsLead}>
      <Card className="rise">
        <CardHead title={t.inThisBrowser} sub={t.everyDevice} />
        <div className={styles.cardBody}>
          <PushSettings />
        </div>
      </Card>
      <p className={styles.note}>{t.quietHours}</p>
    </PageFrame>
  );
}
