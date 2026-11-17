-- Where the files of the workspace are stored (spec, section 8.23): the server's disk, or an S3 bucket the
-- superadmin connected in «Хранилище файлов». One row. `state` says whether files are being moved now:
-- `to_s3` — from the disk into the bucket, `to_local` — back. The keys of the bucket are kept encrypted.
CREATE TABLE app.storage_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  mode text NOT NULL CHECK (mode IN ('local', 's3')),
  state text NOT NULL CHECK (state IN ('active', 'to_s3', 'to_local')),
  provider text,
  endpoint text,
  region text,
  bucket text,
  prefix text NOT NULL DEFAULT '',
  path_style boolean,
  ciphertext bytea,
  iv bytea,
  key_version integer,
  connected_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (mode = 'local' OR (provider IS NOT NULL AND endpoint IS NOT NULL AND region IS NOT NULL AND bucket IS NOT NULL AND path_style IS NOT NULL AND ciphertext IS NOT NULL AND iv IS NOT NULL AND key_version IS NOT NULL)),
  CHECK ((mode = 'local' AND state = 'active') OR mode = 's3')
);

INSERT INTO app.storage_settings (mode, state) VALUES ('local', 'active');

-- What the bucket holds: each file of each area with the size and the time of change it had on the disk
-- when it was stored — a working copy compares its files with these to know what to store again. Search
-- and counts of files read it while an area has no copy on the disk.
CREATE TABLE app.storage_objects (
  area text NOT NULL,
  path text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes >= 0),
  mtime_ms bigint NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (area, path)
);
