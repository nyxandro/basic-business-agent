-- The starter questions of the empty chat are removed (owner's decision 24.11: «никаких подсказок в пустом чате не
-- нужно»): the admin's questions over the passport's go with the feature.
ALTER TABLE app.agent_overrides DROP COLUMN starters;
