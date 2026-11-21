// Environment of the server: only secrets and connection bindings (spec, section 22).
// Every variable is required; a missing one stops the start with APP_CONFIG_INVALID. The one exception is the pair of
// the container of program servers (mcp-runner, docs/specs/[20.11.2026]-mcp-connections.md, F1): both or neither —
// without it program servers are not available, and the admin is told so when adding one.
import { z } from 'zod';
import { configError, formatPath } from './validate.ts';

const MIN_SECRET_LENGTH = 32;

const secret = z.string().min(MIN_SECRET_LENGTH, `must be at least ${MIN_SECRET_LENGTH} characters`);

export const coreEnvSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgres', 'must be a postgresql:// connection string'),
  APP_PUBLIC_URL: z.url(),
  BETTER_AUTH_SECRET: secret,
  APP_ENCRYPTION_KEYS: z.string().min(1),
  LITELLM_URL: z.url(),
  LITELLM_MASTER_KEY: z.string().startsWith('sk-', 'must start with sk- (LiteLLM requirement)'),
  LITELLM_CALLBACK_SECRET: secret,
  // Folder with the employees' workspaces (/workspace in the container).
  APP_WORKSPACE_DIR: z.string().startsWith('/', 'must be an absolute path'),
  // Folder for the unpacked copies of uploaded skills; the server refills it from the database.
  APP_SKILLS_DIR: z.string().startsWith('/', 'must be an absolute path'),
  // Login files of the ChatGPT accounts, shared with LiteLLM (/chatgpt-auth in its container).
  APP_CHATGPT_AUTH_DIR: z.string().startsWith('/', 'must be an absolute path'),
  // The container of program servers (http://mcp-runner:3100 in deploy/compose.yaml) and the secret of its requests.
  MCP_RUNNER_URL: z.url().optional(),
  MCP_RUNNER_SECRET: secret.optional(),
}).refine((env) => (env.MCP_RUNNER_URL === undefined) === (env.MCP_RUNNER_SECRET === undefined), {
  message: 'MCP_RUNNER_URL and MCP_RUNNER_SECRET go together: set both or neither',
  path: ['MCP_RUNNER_SECRET'],
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
