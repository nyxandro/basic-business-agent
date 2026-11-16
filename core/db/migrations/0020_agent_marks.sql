-- The agent's mark moves from «Интерфейс» to each agent (spec, section 8.17; decision of the owner
-- 16.11, replacing «one mark for all agents» of 15.11): an icon of AGENT_ICONS in @bba/contracts
-- (checked by the code, so a new icon needs no migration) or the admin's picture. «Интерфейс» keeps
-- only whether the chat shows the marks at all.
-- An agent without a row shows the spark, as a new installation did. The picture's bytes are kept
-- here, like the archives of skills, so a backup of the database keeps them; a picture stays when an
-- icon is chosen. A row of an agent removed from the installation stays, like its prompt override.
CREATE TABLE app.agent_marks (
  agent_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('icon', 'image')),
  icon text NOT NULL,
  image bytea CHECK (octet_length(image) <= 524288),
  image_type text CHECK (image_type IN ('image/png', 'image/jpeg', 'image/webp')),
  image_sha256 text CHECK (image_sha256 ~ '^[0-9a-f]{64}$'),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((image IS NULL) = (image_type IS NULL) AND (image IS NULL) = (image_sha256 IS NULL)),
  CHECK (kind <> 'image' OR image IS NOT NULL)
);

-- The chat must look the same after the move: the installation's mark goes to every agent the
-- database knows of (departments see it, or its prompt or settings were changed). The registry of
-- agents lives in the files of the installation, not here: an agent known only to the files gets
-- the spark. Only a mark other than the spark is copied — the spark needs no row.
INSERT INTO app.agent_marks (agent_id, kind, icon, image, image_type, image_sha256, updated_by, updated_at)
SELECT known.agent_id,
       CASE WHEN s.agent_mark = 'image' THEN 'image' ELSE 'icon' END,
       s.agent_icon, s.agent_image, s.agent_image_type, s.agent_image_sha256, s.updated_by, s.updated_at
FROM (SELECT agent_id FROM app.department_agents UNION SELECT agent_id FROM app.agent_overrides) AS known
CROSS JOIN app.interface_settings AS s
WHERE s.agent_mark = 'image' OR s.agent_icon <> 'spark' OR s.agent_image IS NOT NULL;

-- «Без значка» becomes the switch turned off.
ALTER TABLE app.interface_settings ADD COLUMN show_agent_mark boolean;
UPDATE app.interface_settings SET show_agent_mark = agent_mark <> 'none';
ALTER TABLE app.interface_settings ALTER COLUMN show_agent_mark SET NOT NULL;

-- Their checks go with them.
ALTER TABLE app.interface_settings
  DROP COLUMN agent_mark,
  DROP COLUMN agent_icon,
  DROP COLUMN agent_image,
  DROP COLUMN agent_image_type,
  DROP COLUMN agent_image_sha256;
