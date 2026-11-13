-- Plugin tables live in their own schema: plugin_<name with underscores>.
CREATE SCHEMA IF NOT EXISTS plugin_example_notes;

CREATE TABLE plugin_example_notes.notes (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_user_idx ON plugin_example_notes.notes (user_id, id DESC);
