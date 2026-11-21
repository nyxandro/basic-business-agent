-- The letterhead, the logo, the stamp and the signature of the organisation (docs/specs/[20.11.2026]-org-letterhead.md).
-- The files live here, like the archives of skills, so a backup of the database keeps them. The server lays out the
-- letterhead (already without its text) and the logo on disk for the sandbox of every answer; the stamp and the
-- signature never go there — only into the one-off sandbox that signs a document.
CREATE TABLE app.org_assets (
  kind text PRIMARY KEY CHECK (kind IN ('blank', 'logo', 'stamp', 'signature')),
  -- What was uploaded: the letterhead as the admin gave it; a picture as the browser prepared it (PNG).
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND CASE WHEN kind = 'blank' THEN 5242880 ELSE 1048576 END),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- The letterhead only: its name for the admin, its copy without text (blank.py) that agents write on, the PDF of that
  -- copy («Так начнётся документ агента») and what blank.py said of it (the line [[ТЕКСТ]], the headers).
  file_name text CHECK (length(file_name) BETWEEN 1 AND 255),
  prepared bytea,
  preview bytea,
  blank_info jsonb,
  -- Pictures only: their size in points.
  width integer CHECK (width > 0),
  height integer CHECK (height > 0),
  -- The signature only: the full name of the director when it was uploaded — a new director asks for a new signature.
  director_name text,
  uploaded_by text REFERENCES app."user" ("id") ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'blank') = (file_name IS NOT NULL)),
  CHECK ((kind = 'blank') = (prepared IS NOT NULL)),
  CHECK ((kind = 'blank') = (preview IS NOT NULL)),
  CHECK ((kind = 'blank') = (blank_info IS NOT NULL)),
  CHECK ((kind = 'blank') = (width IS NULL)),
  CHECK ((kind = 'blank') = (height IS NULL)),
  CHECK (kind = 'signature' OR director_name IS NULL)
);

-- The director as documents name them: the position, the full name and how the signature line reads («И. П. Иванов»).
-- They outrank a name written in the free text of the requisites.
ALTER TABLE app.org_profile
  ADD COLUMN director_position text NOT NULL DEFAULT '' CHECK (length(director_position) <= 200),
  ADD COLUMN director_full_name text NOT NULL DEFAULT '' CHECK (length(director_full_name) <= 200),
  ADD COLUMN director_signature_name text NOT NULL DEFAULT '' CHECK (length(director_signature_name) <= 200);

-- The people who may have the stamp and the signature put through an agent (decision of the owner 21.11, F1). Set only
-- by a superadmin; nobody by default. A person removed from the installation leaves the list with their account.
CREATE TABLE app.org_signers (
  user_id text PRIMARY KEY REFERENCES app."user" ("id") ON DELETE CASCADE,
  added_by text REFERENCES app."user" ("id") ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now()
);

-- How the confirmation card shows a value of a field with a fixed set of values, as it was when asked (field → value →
-- text): «акт» carries the line that a facsimile on it needs the consent of the other party.
ALTER TABLE app.approval_requests ADD COLUMN choices jsonb NOT NULL DEFAULT '{}';
