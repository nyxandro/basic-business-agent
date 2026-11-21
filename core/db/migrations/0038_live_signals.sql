-- The instant channel to open pages (docs/specs/[20.11.2026]-notifications.md, «Мгновенный канал»; decision of the owner
-- 22.11): whatever changes the bell or the states of a person's conversations sends a short signal «this person has
-- news» through Postgres; the server passes it to the person's open tabs, and they read the news again. The signal
-- carries only the id of the person — never what changed.
CREATE FUNCTION app.signal_live() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('bba_live', NEW.user_id);
  RETURN NEW;
END;
$$;

-- A new notification, and one read (it leaves the list and the green mark of its conversation).
CREATE TRIGGER notifications_signal_live AFTER INSERT OR UPDATE OF read_at ON app.notifications
  FOR EACH ROW EXECUTE FUNCTION app.signal_live();
-- A question «Да» asked or decided (the yellow mark of its conversation, «Ждут решения»).
CREATE TRIGGER approval_requests_signal_live AFTER INSERT OR UPDATE OF status ON app.approval_requests
  FOR EACH ROW EXECUTE FUNCTION app.signal_live();
-- A run of a background task queued, started or finished.
CREATE TRIGGER background_task_runs_signal_live AFTER INSERT OR UPDATE OF outcome ON app.background_task_runs
  FOR EACH ROW EXECUTE FUNCTION app.signal_live();
