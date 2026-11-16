-- Two answers in one project at once (independent review 16.11): what left the folder meanwhile may
-- be either's doing, so its row says so instead of naming one of them for sure. Rows before: one answer.
ALTER TABLE app.project_trash ADD COLUMN overlapped boolean;
UPDATE app.project_trash SET overlapped = false;
ALTER TABLE app.project_trash ALTER COLUMN overlapped SET NOT NULL;
