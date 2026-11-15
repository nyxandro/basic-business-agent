-- The order of a person's projects in the side panel (spec, section 8.12; decisions of the owner
-- 15.11.2026). Pinned projects come first, the rest after them; each group in the order of
-- `position`, which the person sets by dragging. A pinned project goes after the pinned ones, an
-- unpinned one and a new one — first among the unpinned. The server always gives the place: no
-- default. Projects made earlier keep the order they had — by name.
ALTER TABLE app.projects
  ADD COLUMN position integer,
  ADD COLUMN pinned boolean NOT NULL DEFAULT false;

UPDATE app.projects p SET position = o.n
FROM (SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY lower(name)) AS n FROM app.projects) o
WHERE p.id = o.id;

ALTER TABLE app.projects ALTER COLUMN position SET NOT NULL;
