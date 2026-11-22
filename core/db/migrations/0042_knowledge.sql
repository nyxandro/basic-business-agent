-- The knowledge base of the organisation (docs/specs/[20.11.2026]-knowledge-base.md): documents of the organisation and
-- of departments, their versions, the fragments the agents search by words, the dictionary of the base's words for
-- typos and the synonyms people add. Search by meaning is not built now (owner 22.11, F4): a column of vectors and
-- its model are added by a later migration without touching these tables.

CREATE TABLE app.kb_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('org', 'department')),
  department_id uuid REFERENCES app.departments (id) ON DELETE RESTRICT,
  -- A document or a sample of a good document (docs/specs/[20.11.2026]-feedback-and-value.md).
  kind text NOT NULL CHECK (kind IN ('document', 'example')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  edition_date date,
  -- The version agents search and open; null until the first one is read.
  current_version integer,
  uploaded_by text REFERENCES app."user" ("id") ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'department') = (department_id IS NOT NULL))
);
CREATE INDEX kb_documents_department_idx ON app.kb_documents (department_id) WHERE department_id IS NOT NULL;

-- A version of a document: the file as uploaded (kept in the database: the base is backed up with it) and how its
-- reading went.
CREATE TABLE app.kb_versions (
  document_id uuid NOT NULL REFERENCES app.kb_documents (id) ON DELETE CASCADE,
  version integer NOT NULL,
  file_name text NOT NULL,
  content bytea NOT NULL,
  size integer NOT NULL,
  sha256 text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'rejected')),
  -- «Готов, но N страниц — сканы»; the code of a refusal.
  warning text,
  error_code text,
  chunks integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, version)
);
CREATE INDEX kb_versions_pending_idx ON app.kb_versions (created_at) WHERE status = 'pending';

-- The fragments of a version: by headings, pages, rows of tables, slides.
CREATE TABLE app.kb_chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id uuid NOT NULL,
  version integer NOT NULL,
  ord integer NOT NULL,
  section text,
  page integer,
  text text NOT NULL,
  -- Lower case, «ё» as «е»: what the trigrams compare.
  norm_text text NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('russian', text)) STORED,
  FOREIGN KEY (document_id, version) REFERENCES app.kb_versions (document_id, version) ON DELETE CASCADE
);
CREATE INDEX kb_chunks_version_idx ON app.kb_chunks (document_id, version);
-- Without a queue of insertions: a search right after a large upload stays fast (as app.message_texts, 8.21).
CREATE INDEX kb_chunks_tsv_idx ON app.kb_chunks USING gin (tsv) WITH (fastupdate = off);
CREATE INDEX kb_chunks_trgm_idx ON app.kb_chunks USING gin (norm_text gin_trgm_ops) WITH (fastupdate = off);

-- The words of the base and in how many fragments each is: typos are corrected towards words the base has.
CREATE TABLE app.kb_words (
  word text PRIMARY KEY,
  count integer NOT NULL CHECK (count > 0)
);
CREATE INDEX kb_words_trgm_idx ON app.kb_words USING gin (word gin_trgm_ops);

-- Groups of words that mean the same in the company, added by those who keep a base: «отгул, день отдыха».
CREATE TABLE app.kb_synonyms (
  group_id uuid NOT NULL,
  word text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('org', 'department')),
  department_id uuid REFERENCES app.departments (id) ON DELETE CASCADE,
  created_by text REFERENCES app."user" ("id") ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, word),
  CHECK ((scope = 'department') = (department_id IS NOT NULL))
);
CREATE INDEX kb_synonyms_word_idx ON app.kb_synonyms (word);
