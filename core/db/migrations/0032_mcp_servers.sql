-- MCP servers the admin adds without a developer (docs/specs/[20.11.2026]-mcp-connections.md, section 8).
-- A server is reached by address (`http`) or runs as a program in the sandbox container (`program`,
-- the owner's decision 21.11: only there, and only without a sign-in of each employee). Its secrets — the
-- client data of the sign-in on the system's site and the values of the shared key — are one sealed JSON.
-- `snapshot` is the list of actions the admin checked: agents get only the enabled ones from it.
CREATE TABLE app.mcp_servers (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^m[0-9a-f]{6}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  transport text NOT NULL CHECK (transport IN ('http', 'program')),
  url text,
  program jsonb,
  auth text NOT NULL CHECK (auth IN ('none', 'oauth', 'personal_key', 'shared_key')),
  fields jsonb NOT NULL,
  header_templates jsonb NOT NULL,
  env_templates jsonb NOT NULL,
  secret_ciphertext bytea,
  secret_iv bytea,
  secret_key_version integer,
  snapshot jsonb NOT NULL,
  snapshot_at timestamptz,
  status text NOT NULL CHECK (status IN ('draft', 'enabled', 'disabled', 'shared_auth_error', 'program_crashed')),
  status_error_code text,
  created_by text REFERENCES app."user" ("id") ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((transport = 'http' AND url IS NOT NULL AND program IS NULL) OR (transport = 'program' AND program IS NOT NULL AND url IS NULL)),
  CHECK (transport = 'http' OR auth IN ('none', 'shared_key')),
  CHECK ((secret_ciphertext IS NULL) = (secret_iv IS NULL) AND (secret_iv IS NULL) = (secret_key_version IS NULL))
);

-- Which agents may use a server (the admin's choice; a person sees it only through these agents).
CREATE TABLE app.mcp_server_agents (
  server_id uuid NOT NULL REFERENCES app.mcp_servers (id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  PRIMARY KEY (server_id, agent_id)
);
CREATE INDEX mcp_server_agents_agent_idx ON app.mcp_server_agents (agent_id);

-- Servers each employee turned on for themselves (the owner's decision 21.11: the admin adds a server once,
-- people use it from the allowed ones). A sign-in or a key of the person is kept in app.connector_credentials.
CREATE TABLE app.mcp_server_users (
  server_id uuid NOT NULL REFERENCES app.mcp_servers (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  enabled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX mcp_server_users_user_idx ON app.mcp_server_users (user_id);

-- Where the sign-in on the system's site found its addresses: needed again when the browser comes back.
ALTER TABLE app.oauth_states ADD COLUMN discovery_state jsonb;
