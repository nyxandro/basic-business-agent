-- The mailboxes of employees (spec, section 8.24): each person connects their own; the agent reads and sends
-- with that person's access. The password or the tokens of the sign-in are kept encrypted (JSON in
-- `ciphertext`). `sent_folder` — where a sent letter is put when the service does not keep it itself.
CREATE TABLE app.mail_accounts (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  email text NOT NULL,
  provider text NOT NULL,
  auth text NOT NULL CHECK (auth IN ('password', 'oauth')),
  imap_host text NOT NULL,
  imap_port integer NOT NULL,
  imap_security text NOT NULL CHECK (imap_security IN ('tls', 'starttls')),
  smtp_host text NOT NULL,
  smtp_port integer NOT NULL,
  smtp_security text NOT NULL CHECK (smtp_security IN ('tls', 'starttls')),
  login text NOT NULL,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  key_version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('connected', 'auth_error')),
  last_error_code text,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, email)
);

-- The apps of the services' sign-in (Google, Microsoft, Yandex) the admin registered once for the organisation.
CREATE TABLE app.mail_oauth_apps (
  provider text PRIMARY KEY CHECK (provider IN ('google', 'microsoft', 'yandex')),
  client_id text NOT NULL,
  tenant text,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  key_version integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One pending sign-in of a mailbox per row: single-use, short-lived; the PKCE verifier never leaves the server.
CREATE TABLE app.mail_oauth_states (
  state_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  provider text NOT NULL,
  email text NOT NULL,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX mail_oauth_states_user_idx ON app.mail_oauth_states (user_id);
