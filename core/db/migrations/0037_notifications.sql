-- Notifications in the browser (docs/specs/[20.11.2026]-notifications.md): the list under the bell is the source of
-- truth, the push to the browser is a delivery of a row of it. A notification names only what it is about (an action,
-- a task, a system, a project) — never text of a conversation, a document or the parameters of an action.
CREATE TABLE app.notifications (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{1,40}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) <= 300),
  -- Where a click leads: an address inside the app.
  link text NOT NULL CHECK (link ~ '^/'),
  -- What it is about, to tell "already decided" at delivery: 'approval:<id>' and the like.
  subject_ref text,
  -- The conversation it is about: opening it marks the notification read.
  thread_id text,
  -- One notification per case: a repeat of the same event writes nothing.
  dedup_key text NOT NULL CHECK (length(dedup_key) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (user_id, dedup_key)
);
CREATE INDEX notifications_user_idx ON app.notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON app.notifications (user_id) WHERE read_at IS NULL;
CREATE INDEX notifications_thread_idx ON app.notifications (user_id, thread_id) WHERE read_at IS NULL AND thread_id IS NOT NULL;
-- The weekly cleanup removes rows older than 30 days by this.
CREATE INDEX notifications_created_idx ON app.notifications (created_at);

-- One delivery per notification and channel; the browser is the only channel (letters may come later, section 14).
CREATE TABLE app.notification_deliveries (
  notification_id uuid NOT NULL REFERENCES app.notifications (id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('push')),
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  send_after timestamptz NOT NULL DEFAULT now(),
  error_code text,
  sent_at timestamptz,
  PRIMARY KEY (notification_id, channel)
);
CREATE INDEX notification_deliveries_due_idx ON app.notification_deliveries (send_after) WHERE status = 'pending';

-- A browser that agreed to notifications. The address is the browser's own: when another person turns notifications on
-- in the same browser, it moves to them.
CREATE TABLE app.push_subscriptions (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE CHECK (endpoint ~ '^https?://' AND length(endpoint) <= 2048),
  p256dh text NOT NULL CHECK (length(p256dh) BETWEEN 1 AND 200),
  auth text NOT NULL CHECK (length(auth) BETWEEN 1 AND 100),
  user_agent text CHECK (length(user_agent) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz
);
CREATE INDEX push_subscriptions_user_idx ON app.push_subscriptions (user_id);

-- The VAPID keys of the installation, made at the first start; the private one is sealed (core/crypto/secret-box.ts).
CREATE TABLE app.notification_keys (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  public_key text NOT NULL,
  private_ciphertext bytea NOT NULL,
  private_iv bytea NOT NULL,
  key_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- How long a question «Да» waits before it burns (decision of the owner 21.11, F4): set in «Режимы работы»; the starting
-- values come from config/app.ts. A question keeps the term it was asked with (expires_at).
CREATE TABLE app.approval_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  chat_ttl_hours integer NOT NULL CHECK (chat_ttl_hours BETWEEN 1 AND 720),
  background_ttl_hours integer NOT NULL CHECK (background_ttl_hours BETWEEN 1 AND 720),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- What kind of run asked: the term and where the question is shown. Rows before this migration: a task's question is a
-- background one, a conversation of a plugin's run ("ev:") too, the rest — of the chat.
ALTER TABLE app.approval_requests ADD COLUMN run_kind text CHECK (run_kind IN ('chat', 'background', 'draft'));
UPDATE app.approval_requests SET run_kind = CASE WHEN task_id IS NOT NULL OR thread_id LIKE 'ev:%' THEN 'background' ELSE 'chat' END;
ALTER TABLE app.approval_requests ALTER COLUMN run_kind SET NOT NULL;
-- A burnt question of a conversation: when its waiting answer got the refusal (at the next message there).
ALTER TABLE app.approval_requests ADD COLUMN closed_at timestamptz;
CREATE INDEX approval_requests_pending_expiry_idx ON app.approval_requests (expires_at) WHERE status = 'pending';

-- «Новые результаты» of background tasks are told by the notification «Готово: задача» now.
ALTER TABLE app.background_task_runs DROP COLUMN unread;
