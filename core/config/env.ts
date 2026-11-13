// Environment of the server: only secrets and connection bindings (spec, section 22).
// Every variable is required; a missing one stops the start with APP_CONFIG_INVALID.
import { z } from 'zod';
import { configError, formatPath } from './validate.ts';

const MIN_SECRET_LENGTH = 32;

const secret = z.string().min(MIN_SECRET_LENGTH, `must be at least ${MIN_SECRET_LENGTH} characters`);

export const coreEnvSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgres', 'must be a postgresql:// connection string'),
  APP_PUBLIC_URL: z.url(),
  BETTER_AUTH_SECRET: secret,
});
export type CoreEnv = z.infer<typeof coreEnvSchema>;

export function readCoreEnv(env: Record<string, string | undefined>): CoreEnv {
  const parsed = coreEnvSchema.safeParse(env);
  if (parsed.success) return parsed.data;
  throw configError(
    parsed.error.issues.map((issue) => ({
      file: '.env',
      field: formatPath(issue.path),
      message: issue.code === 'invalid_type' ? 'is not set' : issue.message,
    })),
  );
}
