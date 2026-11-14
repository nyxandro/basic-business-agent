-- Small additions of stage 2 (spec, step 36):
-- - the organisation's name is the admin's to change («Профиль организации»); config/app.ts gives
--   only the first one;
-- - the admin may replace an agent's starter questions (at most 3; NULL — the passport's);
-- - a background task's question keeps the action's name and the labels of its fields as they were
--   when it was asked (summary — the name, labels — field → label).
ALTER TABLE app.org_profile ADD COLUMN name text CHECK (name IS NULL OR length(btrim(name)) BETWEEN 1 AND 120);
ALTER TABLE app.agent_overrides ADD COLUMN starters text[] CHECK (starters IS NULL OR cardinality(starters) <= 3);
ALTER TABLE app.approval_requests ADD COLUMN labels jsonb NOT NULL DEFAULT '{}';
