import { z } from 'zod';

const rub = z.number().min(0).nullable();
const tokens = z.number().int().positive().nullable();

export const limitSettingsSchema = z.object({
  orgMonthlyRub: rub,
  defaultUserMonthlyRub: rub,
  defaultDailySubscriptionTokens: tokens,
});
export type LimitSettingsBody = z.infer<typeof limitSettingsSchema>;

// A personal value replaces the default; null means "the default applies".
export const userLimitsSchema = z.object({ monthlyRub: rub, dailySubscriptionTokens: tokens });

export const orgProfileSchema = z.object({
  tone: z.string().max(2000),
  requisites: z.string().max(4000),
  industry: z.string().max(500),
});

export const MASKING_KIND_IDS = ['passport', 'snils', 'card', 'inn', 'phone', 'email'] as const;
export const maskingSettingsSchema = z.object({ kinds: z.array(z.enum(MASKING_KIND_IDS)) });

export const promptDraftSchema = z.object({ text: z.string(), baseDraftVersionId: z.string().nullable() });
export const agentModelSchema = z.object({ modelId: z.string().nullable() });

export const userProfileSchema = z.object({ name: z.string().trim().min(1), position: z.string().max(200) });

export const journalQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  userId: z.string().optional(),
  agentId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
});
