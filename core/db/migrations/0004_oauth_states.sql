-- One pending OAuth sign-in per row (spec, section 8.8): the state is single-use and short-lived;
-- the PKCE verifier never leaves the server.
CREATE TABLE app.oauth_states (
  state_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  connector_id text NOT NULL,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL
);
