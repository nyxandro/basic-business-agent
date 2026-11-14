-- ChatGPT subscription accounts of the pool (spec, sections 8.1 and 17.4). The admin connects an
-- account by a device code on OpenAI's site; its tokens are kept encrypted here, and the working copy
-- is a file in the volume shared with LiteLLM, which refreshes the token in it.
CREATE TABLE app.chatgpt_accounts (
  id text PRIMARY KEY CHECK (id ~ '^a-[0-9a-f]{8}$'),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  -- The workspace of the subscription (claim chatgpt_account_id of the token): one person may have
  -- a personal subscription and a team's, two subscriptions with their own limits.
  chatgpt_account_id text,
  -- The login file of LiteLLM ({access_token, refresh_token, id_token, expires_at, account_id}), AES-256-GCM.
  auth_ciphertext bytea NOT NULL,
  auth_iv bytea NOT NULL,
  auth_key_version integer NOT NULL,
  auth_updated_at timestamptz NOT NULL DEFAULT now(),
  -- auth_error: OpenAI refused the login; the account is out of LiteLLM until the admin logs in again.
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'auth_error')),
  connected_by text REFERENCES app."user" ("id") ON DELETE SET NULL,
  connected_at timestamptz NOT NULL DEFAULT now()
);
-- One subscription once in the pool: connected twice, the copies share one refresh token, and after
-- LiteLLM refreshes it in one file the other gets 401 (the experience of an earlier project).
CREATE UNIQUE INDEX chatgpt_accounts_identity_idx ON app.chatgpt_accounts (lower(email), chatgpt_account_id) NULLS NOT DISTINCT;

-- Logins in progress: the admin's page asks every few seconds whether the person has entered the
-- code; a row lives at most 15 minutes and goes away when the login ends either way.
CREATE TABLE app.chatgpt_logins (
  id text PRIMARY KEY CHECK (id ~ '^l-[0-9a-f]{8}$'),
  -- device_auth_id of OpenAI: with the user code it fetches the tokens, so it is a secret.
  device_ciphertext bytea NOT NULL,
  device_iv bytea NOT NULL,
  device_key_version integer NOT NULL,
  user_code text NOT NULL CHECK (length(user_code) BETWEEN 1 AND 64),
  interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 1 AND 60),
  -- «Войти заново» of an account; NULL — a new account.
  account_id text REFERENCES app.chatgpt_accounts (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  polled_at timestamptz,
  started_by text REFERENCES app."user" ("id") ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now()
);

-- Failed attempts of the accounts' deployments, as LiteLLM reports each of them (its generic_api
-- callback, llm_api_failure). Successes are in app.usage_events. Kept 30 days.
CREATE TABLE app.account_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL,
  account_id text NOT NULL REFERENCES app.chatgpt_accounts (id) ON DELETE CASCADE,
  deployment text NOT NULL,
  -- HTTP status of the failure; NULL when LiteLLM named none (e.g. a broken connection).
  status integer,
  code text,
  cooldown_until timestamptz,
  litellm_call_id text NOT NULL,
  -- LiteLLM may send the same attempt twice; one call tries a deployment at most once that counts.
  CONSTRAINT account_events_call_unique UNIQUE (litellm_call_id, deployment)
);
CREATE INDEX account_events_account_at_idx ON app.account_events (account_id, at);

-- The last success and today's tokens of an account without scanning a month of usage: the
-- deployment of an account is "<model>:<account>", so its second part names the account.
CREATE INDEX usage_events_account_idx ON app.usage_events ((split_part(deployment, ':', 2)), at) WHERE is_subscription;
