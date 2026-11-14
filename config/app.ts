// The installation: name, time zone (month limits reset at 00:00 of the 1st here), what the model
// must not see from the start, starting limits. Admins change masking and limits in the admin panel.
import { defineAppConfig } from '../core/config/public/index.ts';

export default defineAppConfig({
  name: 'Демо-организация',
  timezone: 'Europe/Moscow',
  masking: { initialKinds: ['passport', 'snils', 'card', 'inn'] },
  limits: { initialOrgMonthlyRub: null, initialUserMonthlyRub: null, initialDailySubscriptionTokens: null },
});
