-- Initial schema of the installation (spec, section 17.4).
-- Schema `app` holds Better Auth tables and ours; Mastra uses schema `mastra`, LiteLLM — `litellm`.

CREATE SCHEMA IF NOT EXISTS mastra;
CREATE SCHEMA IF NOT EXISTS litellm;

-- Better Auth (core schema). Column names follow Better Auth's camelCase convention.
CREATE TABLE app."user" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app."session" (
  "id" text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE
);
CREATE INDEX session_user_idx ON app."session" ("userId");

CREATE TABLE app."account" (
  "id" text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL
);
CREATE INDEX account_user_idx ON app."account" ("userId");

CREATE TABLE app."verification" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier_idx ON app."verification" ("identifier");

-- Append-only guard for journals: rows are never changed or removed.
CREATE FUNCTION app.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'APP_DB_APPEND_ONLY: % is append-only', TG_TABLE_NAME;
END;
$$;

-- Roles, departments, profiles
CREATE TABLE app.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  builtin text UNIQUE CHECK (builtin IN ('superadmin', 'employee')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.user_roles (
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES app.roles (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE app.departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.department_members (
  department_id uuid NOT NULL REFERENCES app.departments (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  PRIMARY KEY (department_id, user_id)
);

CREATE TABLE app.department_agents (
  department_id uuid NOT NULL REFERENCES app.departments (id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  PRIMARY KEY (department_id, agent_id)
);

CREATE TABLE app.org_profile (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  tone text NOT NULL DEFAULT '',
  requisites text NOT NULL DEFAULT '',
  industry text NOT NULL DEFAULT '',
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.user_profiles (
  user_id text PRIMARY KEY REFERENCES app."user" ("id") ON DELETE CASCADE,
  position text NOT NULL DEFAULT '',
  blocked_at timestamptz,
  deletion_started_at timestamptz
);

-- Invites and password resets: only a hash of the one-time token is stored.
CREATE TABLE app.invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  role_ids uuid[] NOT NULL DEFAULT '{}',
  department_ids uuid[] NOT NULL DEFAULT '{}',
  token_hash text NOT NULL UNIQUE,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE app.password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz
);

-- Limits: values set by the admin; LiteLLM enforces monthly budgets, the app enforces the daily cap.
CREATE TABLE app.limit_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  org_monthly_rub numeric(14, 2),
  default_user_monthly_rub numeric(14, 2),
  default_daily_subscription_tokens bigint,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.user_limits (
  user_id text PRIMARY KEY REFERENCES app."user" ("id") ON DELETE CASCADE,
  monthly_rub numeric(14, 2),
  daily_subscription_tokens bigint,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Secrets encrypted with AES-256-GCM; key_version tells which key encrypted the row.
CREATE TABLE app.model_keys (
  user_id text PRIMARY KEY REFERENCES app."user" ("id") ON DELETE CASCADE,
  litellm_key_ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  key_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.connector_credentials (
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  connector_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('static', 'oauth')),
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  key_version integer NOT NULL,
  expires_at timestamptz,
  status text NOT NULL CHECK (status IN ('connected', 'unverified', 'auth_error')),
  checked_at timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, connector_id)
);

-- Usage ledger: one row per model call, sent by LiteLLM's callback.
CREATE TABLE app.usage_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL,
  user_id text,
  team_id text,
  agent_id text,
  model text NOT NULL,
  deployment text,
  is_subscription boolean NOT NULL DEFAULT false,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cache_read_tokens integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  reasoning_tokens integer NOT NULL DEFAULT 0,
  cost_rub numeric(20, 10) NOT NULL DEFAULT 0,
  aborted boolean NOT NULL DEFAULT false,
  litellm_call_id text NOT NULL UNIQUE
);
CREATE INDEX usage_events_user_at_idx ON app.usage_events (user_id, at);
CREATE INDEX usage_events_at_idx ON app.usage_events (at);

-- Background tasks: the source of truth; Mastra schedules are derived from these rows.
CREATE TABLE app.background_tasks (
  id text PRIMARY KEY,
  title text NOT NULL,
  agent_id text NOT NULL,
  owner_user_id text REFERENCES app."user" ("id") ON DELETE SET NULL,
  cron text NOT NULL,
  prompt text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'paused')),
  paused_reason text,
  schedule_id text,
  thread_id text NOT NULL,
  unread_result boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  agent_id text NOT NULL,
  task_id text REFERENCES app.background_tasks (id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  run_id text NOT NULL,
  tool_call_id text NOT NULL,
  tool text NOT NULL,
  summary text NOT NULL,
  args jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'failed')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  expires_at timestamptz NOT NULL,
  UNIQUE (run_id, tool_call_id)
);
CREATE INDEX approval_requests_user_status_idx ON app.approval_requests (user_id, status);
CREATE INDEX approval_requests_task_status_idx ON app.approval_requests (task_id, status);

CREATE TABLE app.action_journal (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id text,
  agent_id text,
  run_kind text NOT NULL CHECK (run_kind IN ('chat', 'background')),
  task_id text,
  event text NOT NULL,
  tool text,
  args_summary jsonb,
  approved_by text,
  result text NOT NULL,
  error_code text
);
CREATE INDEX action_journal_at_idx ON app.action_journal (at);
CREATE TRIGGER action_journal_append_only BEFORE UPDATE OR DELETE ON app.action_journal
  FOR EACH ROW EXECUTE FUNCTION app.forbid_change();

CREATE TABLE app.agent_overrides (
  agent_id text PRIMARY KEY,
  file_instructions_hash text NOT NULL,
  published_by text,
  published_at timestamptz
);

CREATE TABLE app.admin_audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_user_id text,
  action text NOT NULL,
  target text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TRIGGER admin_audit_append_only BEFORE UPDATE OR DELETE ON app.admin_audit
  FOR EACH ROW EXECUTE FUNCTION app.forbid_change();

-- Masking (spec, section 8.11)
CREATE TABLE app.masking_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  kinds jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.masking_map (
  thread_id text NOT NULL,
  kind text NOT NULL,
  placeholder text NOT NULL,
  value_hash text NOT NULL,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, placeholder),
  UNIQUE (thread_id, value_hash)
);
