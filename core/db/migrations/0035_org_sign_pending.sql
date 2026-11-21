-- What a card «Да» of the stamp and the signature asked about (docs/specs/[20.11.2026]-org-letterhead.md, independent
-- review 21.11): the fingerprint of the document when the card was shown. After «Да» only the same bytes are signed — a
-- document replaced at the same path meanwhile (by a colleague's answer in a shared project, by the agent itself) is not.
-- A row lives from the card to the answer; rows of cards nobody answered go after the life of a question.
CREATE TABLE app.org_sign_pending (
  tool_call_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_sign_pending_user_idx ON app.org_sign_pending (user_id);
CREATE INDEX org_sign_pending_created_idx ON app.org_sign_pending (created_at);
