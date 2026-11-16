-- Search with typos, word forms, transliteration and keyboard layout (spec, section 8.21): pg_trgm for
-- typos and pieces of words, and the text a person saw in a message, for an index on it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The text parts of a message Mastra stored (JSON text with "parts"), lower case, «ё» as «е»: what the
-- person and the agent wrote, without tool calls and their results (a hundred times larger, not
-- searched, section 8.13). The index on Mastra's table runs this on every saved message, so anything
-- else than the expected form gives '' and never an error: an error here would stop the chat saving.
-- The index itself is made by the server once Mastra has made its tables (core/search/text-index.ts).
-- Changing this function needs a migration that drops that index: the server builds it again.
CREATE FUNCTION app.message_search_text(content text) RETURNS text
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
  RETURN replace(lower(coalesce(joined, '')), 'ё', 'е');
EXCEPTION WHEN OTHERS THEN
  RETURN '';
END;
$$;
