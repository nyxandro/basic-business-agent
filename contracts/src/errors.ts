import { z } from 'zod';

// Error body of every /app/api response (spec, section 17.5): a stable code for support,
// a plain-Russian message for the person and, when there is one, what to do next.
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().regex(/^APP_[A-Z0-9_]+$/),
    message: z.string().min(1),
    nextStep: z.string().min(1).optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
