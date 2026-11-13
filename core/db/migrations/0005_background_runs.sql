-- When the last run of a background task started: compared with the cron schedule at start-up
-- to give one catch-up run for a fire missed during a restart (spec, section 8.6).
ALTER TABLE app.background_tasks ADD COLUMN last_run_at timestamptz;
