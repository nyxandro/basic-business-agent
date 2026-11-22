-- The ceiling of 100 letters an hour is per mailbox (docs/specs/[20.11.2026]-event-tasks.md, F2): the mailbox of a letter
-- is kept with its event — its content goes once the run ends, and skipped events never had it.
ALTER TABLE app.task_events ADD COLUMN mail_account_id uuid;
CREATE INDEX task_events_mailbox_idx ON app.task_events (task_id, mail_account_id, received_at) WHERE mail_account_id IS NOT NULL;
