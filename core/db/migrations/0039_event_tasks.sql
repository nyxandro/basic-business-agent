-- Background tasks by an event (docs/specs/[20.11.2026]-event-tasks.md): besides a schedule, a task starts on a letter
-- in an employee's mailbox or on a message another system sends to the task's address.

-- The kind of start. Every task before this migration runs by its schedule.
ALTER TABLE app.background_tasks ADD COLUMN trigger text;
UPDATE app.background_tasks SET trigger = 'schedule';
ALTER TABLE app.background_tasks
  ALTER COLUMN trigger SET NOT NULL,
  ADD CONSTRAINT background_tasks_trigger_known CHECK (trigger IN ('schedule', 'mail', 'webhook')),
  ALTER COLUMN cron DROP NOT NULL,
  ADD CONSTRAINT background_tasks_cron_by_trigger CHECK ((trigger = 'schedule') = (cron IS NOT NULL)),
  -- The filters of a mail task: { "from": [...], "subject": [...] } — addresses or domains, words of the subject.
  ADD COLUMN mail_filter jsonb,
  ADD CONSTRAINT background_tasks_mail_filter CHECK ((trigger = 'mail') = (mail_filter IS NOT NULL)),
  -- The secret of the address of a webhook task, encrypted (SecretBox); its hash finds the task by the address.
  ADD COLUMN webhook_ciphertext bytea,
  ADD COLUMN webhook_iv bytea,
  ADD COLUMN webhook_key_version integer,
  ADD COLUMN webhook_secret_hash text UNIQUE,
  ADD CONSTRAINT background_tasks_webhook_secret CHECK ((trigger = 'webhook') = (webhook_secret_hash IS NOT NULL)),
  -- On whose behalf a message of another system is handled (owner 21.11, F1: the employee chosen in the task; the
  -- employee named by the event is a later option — the mode keeps the way to it open).
  ADD COLUMN executor_mode text,
  ADD CONSTRAINT background_tasks_executor_mode CHECK (executor_mode IS NULL OR executor_mode IN ('fixed')),
  ADD COLUMN executor_id text REFERENCES app."user" ("id") ON DELETE SET NULL,
  -- Since when the task takes events: its creation or the end of its pause. Letters older than this are not handled.
  ADD COLUMN activated_at timestamptz;
UPDATE app.background_tasks SET activated_at = created_at;
ALTER TABLE app.background_tasks ALTER COLUMN activated_at SET NOT NULL;

-- One event of a task. A key is unique in the task while it lasts: a letter's Message-ID or a system's own event id —
-- for good (`key_until` NULL); the fingerprint of a body without an id — for a day.
CREATE TABLE app.task_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id text NOT NULL REFERENCES app.background_tasks (id) ON DELETE CASCADE,
  -- Whose run it is: the owner of the mailbox, the executor of a webhook task.
  user_id text REFERENCES app."user" ("id") ON DELETE SET NULL,
  event_key text NOT NULL,
  key_until timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  -- What the admin sees in «Последние события»: the first characters of a system's message; nothing of a letter.
  summary text,
  -- The body of a system's message (up to 64 KB) or the place of a letter; removed once it is no longer needed.
  payload jsonb,
  outcome text NOT NULL CHECK (outcome IN ('queued', 'skipped_flood', 'skipped_paused', 'skipped_executor', 'done', 'awaiting-approval', 'failed')),
  reason_code text
);
CREATE INDEX task_events_key_idx ON app.task_events (task_id, event_key);
CREATE INDEX task_events_recent_idx ON app.task_events (task_id, received_at DESC);

-- Messages the address refused (a wrong format, too large): a counter per task and day.
CREATE TABLE app.task_event_rejects (
  task_id text NOT NULL REFERENCES app.background_tasks (id) ON DELETE CASCADE,
  day date NOT NULL,
  reason text NOT NULL CHECK (reason IN ('too_large', 'bad_format')),
  count integer NOT NULL,
  PRIMARY KEY (task_id, day, reason)
);

-- A run made by an event: one per event, taken from the queue before the runs of schedules.
ALTER TABLE app.background_task_runs
  ADD COLUMN event_id bigint REFERENCES app.task_events (id) ON DELETE CASCADE,
  ADD COLUMN priority smallint NOT NULL DEFAULT 1 CHECK (priority IN (0, 1)),
  DROP CONSTRAINT background_task_runs_once;
CREATE UNIQUE INDEX background_task_runs_once ON app.background_task_runs (task_id, fire_at, user_id) WHERE event_id IS NULL;
CREATE UNIQUE INDEX background_task_runs_event_once ON app.background_task_runs (event_id) WHERE event_id IS NOT NULL;
DROP INDEX app.background_task_runs_queue_idx;
CREATE INDEX background_task_runs_queue_idx ON app.background_task_runs (priority, fire_at, id) WHERE outcome = 'queued';
ALTER TABLE app.background_task_runs ALTER COLUMN priority DROP DEFAULT;

-- Where the check of a mailbox stopped: the number of the last letter seen, valid with its UIDVALIDITY.
CREATE TABLE app.mail_trigger_cursors (
  mail_account_id uuid NOT NULL REFERENCES app.mail_accounts (id) ON DELETE CASCADE,
  folder text NOT NULL,
  uidvalidity bigint NOT NULL,
  last_uid bigint NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mail_account_id, folder)
);
