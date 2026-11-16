-- The dictionary of the search after the independent review of 16.11 (spec, section 8.21).
-- 1. Only words of letters: typos are corrected only in words of letters, and numbers of three digits and
--    more (phones, tax numbers, cards) must not stay in a list nobody needs them in.
-- 2. The text of a message and its words are kept in two protected steps: a failure with the words
--    (two saves adding the same new words at once) no longer undoes the new text of the message.
--    Words go in one order, so two such saves wait for each other instead of locking each other.
CREATE OR REPLACE FUNCTION app.text_words(content text) RETURNS SETOF text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT w FROM regexp_split_to_table(replace(lower(coalesce(content, '')), 'ё', 'е'), '[^0-9a-zа-я]+') AS w
   WHERE length(w) >= 3 AND w ~ '^[a-zа-я]+$'
$$;

DELETE FROM app.search_words WHERE word !~ '^[a-zа-я]+$';

CREATE OR REPLACE FUNCTION app.keep_message_text() RETURNS trigger
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
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'APP_SEARCH_TEXT_SKIPPED: message text not kept for search: %', SQLERRM;
    RETURN NULL;
  END;
  IF visible IS NOT NULL THEN
    BEGIN
      INSERT INTO app.search_words (word) SELECT w FROM app.text_words(visible) AS w ORDER BY w ON CONFLICT DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'APP_SEARCH_WORDS_SKIPPED: words of a message not kept for search: %', SQLERRM;
    END;
  END IF;
  RETURN NULL;
END;
$$;
