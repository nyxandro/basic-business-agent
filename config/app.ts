// The installation: name, time zone (month limits reset at 00:00 of the 1st here), what the model
// must not see from the start, starting limits, how long a question «Да» waits (hours). Admins change masking, limits
// and the terms of questions in the admin panel.
import { defineAppConfig } from '../core/config/public/index.ts';

export default defineAppConfig({
  name: 'Демо-организация',
  timezone: 'Europe/Moscow',
  masking: { initialKinds: ['passport', 'snils', 'card', 'inn'] },
  limits: { initialOrgMonthlyRub: null, initialUserMonthlyRub: null, initialDailySubscriptionTokens: null },
  approvals: { initialChatTtlHours: 24, initialBackgroundTtlHours: 72 },
});
