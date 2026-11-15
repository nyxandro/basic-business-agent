-- «Интерфейс» in the admin panel (spec, section 8.17): how the chat looks for every employee, one
-- row for the installation.
-- The agent's mark: an icon of AGENT_ICONS in @bba/contracts (checked by the code, so a new icon
-- needs no migration), the admin's picture or none. The picture's bytes are kept here, like the
-- archives of skills, so a backup of the database keeps it; it stays when another mark is chosen.
-- A new installation shows the spark, as before this section existed.
CREATE TABLE app.interface_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  agent_mark text NOT NULL CHECK (agent_mark IN ('icon', 'image', 'none')),
  agent_icon text NOT NULL,
  agent_image bytea CHECK (octet_length(agent_image) <= 524288),
  agent_image_type text CHECK (agent_image_type IN ('image/png', 'image/jpeg', 'image/webp')),
  agent_image_sha256 text CHECK (agent_image_sha256 ~ '^[0-9a-f]{64}$'),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((agent_image IS NULL) = (agent_image_type IS NULL) AND (agent_image IS NULL) = (agent_image_sha256 IS NULL)),
  CHECK (agent_mark <> 'image' OR agent_image IS NOT NULL)
);

INSERT INTO app.interface_settings (agent_mark, agent_icon) VALUES ('icon', 'spark');
