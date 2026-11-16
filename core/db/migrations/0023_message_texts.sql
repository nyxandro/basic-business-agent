-- The text people saw in messages, kept in a table of ours (spec, section 8.21) instead of an index on an
-- expression over Mastra's messages: that index stored only trigrams, so every candidate message was parsed
-- again from its JSON with the tool results — 20 KB and more each (24 KB on average in the development
-- installation, 16.11) — and a search over heavy conversations took 0.5 s. Here the search reads short text.
DROP INDEX IF EXISTS mastra.bba_messages_search_text;
DROP FUNCTION IF EXISTS app.message_search_text(text);

-- The text parts of a message Mastra stored (JSON text with "parts"), as written, joined by a line break:
-- what the person and the agent wrote, without tool calls and their results (not searched, section 8.13).
-- Anything else than the expected form gives '' and never an error: it runs inside Mastra's writes.
CREATE FUNCTION app.message_visible_text(content text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  parts jsonb;
  joined text;
BEGIN
  IF content IS NULL OR left(content, 1) <> '{' THEN
    RETURN '';
  END IF;
  parts := content::jsonb -> 'parts';
  IF jsonb_typeof(parts) IS DISTINCT FROM 'array' THEN
    RETURN '';
  END IF;
  SELECT string_agg(part ->> 'text', E'\n' ORDER BY n)
    INTO joined
    FROM jsonb_array_elements(parts) WITH ORDINALITY AS p(part, n)
   WHERE jsonb_typeof(part) = 'object' AND part ->> 'type' = 'text' AND part ->> 'text' IS NOT NULL;
  RETURN coalesce(joined, '');
EXCEPTION WHEN OTHERS THEN
  RETURN '';
END;
$$;

-- One row per message of a person or an agent. Kept by the trigger app.keep_message_text on Mastra's
-- messages, which the server puts on at every start (core/search/message-texts.ts) — Mastra makes its
-- tables after our migrations — and fills in what was saved while the trigger was not there.
CREATE TABLE app.message_texts (
  message_id text PRIMARY KEY,
  thread_id text NOT NULL,
  resource_id text,
  role text NOT NULL,
  created_at timestamptz,
  text text NOT NULL
);
CREATE INDEX message_texts_thread ON app.message_texts (thread_id, created_at);
CREATE INDEX message_texts_resource ON app.message_texts (resource_id);
-- The expression is the one the search compares by (normalizedSql, core/search/match-sql.ts). Without the
-- pending list of GIN: messages come at a person's pace, and a search must not read an unsorted list of
-- fresh entries on every condition until the background maintenance merges it (seconds after a burst).
CREATE INDEX message_texts_search ON app.message_texts USING gin ((replace(lower(coalesce(text, '')), 'ё', 'е')) gin_trgm_ops) WITH (fastupdate = off);

-- The words people have written, for correcting a typo of the query (the way the documentation of pg_trgm
-- suggests): a typo is first matched against these short words — thousands, not thousands of messages — and
-- the words it means are then searched as pieces through message_texts_search. Words of every person of
-- the organisation: a correction is only searched in the person's own conversations, never shown. A word of
-- a removed message stays — it only corrects to something that finds nothing.
CREATE TABLE app.search_words (word text PRIMARY KEY);
CREATE INDEX search_words_trgm ON app.search_words USING gin (word gin_trgm_ops) WITH (fastupdate = off);

-- The words of a text, as the search compares them: lower case, «ё» as «е», letters and digits, from 3.
CREATE FUNCTION app.text_words(content text) RETURNS SETOF text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT w FROM regexp_split_to_table(replace(lower(coalesce(content, '')), 'ё', 'е'), '[^0-9a-zа-я]+') AS w WHERE length(w) >= 3
$$;

-- Never stops Mastra saving a message: a failure leaves the message without its text here, with a warning in
-- the database log, and the next start of the server fills it in.
CREATE FUNCTION app.keep_message_text() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  visible text;
BEGIN
  BEGIN
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
      DELETE FROM app.message_texts WHERE message_id = OLD.id;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.role IN ('user', 'assistant') THEN
      visible := app.message_visible_text(NEW.content);
      INSERT INTO app.message_texts (message_id, thread_id, resource_id, role, created_at, text)
      VALUES (NEW.id, NEW.thread_id, NEW."resourceId", NEW.role, NEW."createdAtZ", visible)
      ON CONFLICT (message_id) DO UPDATE
        SET thread_id = EXCLUDED.thread_id, resource_id = EXCLUDED.resource_id, role = EXCLUDED.role,
            created_at = EXCLUDED.created_at, text = EXCLUDED.text;
      INSERT INTO app.search_words (word) SELECT app.text_words(visible) ON CONFLICT DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'APP_SEARCH_TEXT_SKIPPED: message text not kept for search: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;
