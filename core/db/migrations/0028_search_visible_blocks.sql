-- The search finds what the person saw in blocks of the interface too (spec, sections 8.21 and 8.28; owner's
-- decision F25, 18.11): the title, column names and cells of a table — drawn by show_table or by a tool whose
-- result is a table —, a card, the title, labels and series of a chart, the question and options of a choice,
-- the title and fields of a form, the name of a file shown. A block the person did not see (its call failed
-- the check or did not finish) is not searched, nor are the calls of other tools: commands, files read,
-- answers of systems. The agent reading an old conversation gets the same blocks (core/history/transcript.ts).

-- The words of a table: title, column names, cells.
CREATE FUNCTION app.table_visible_text(t jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT concat_ws(E'\n',
    t ->> 'title',
    (SELECT string_agg(c ->> 'label', ' ') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t -> 'columns') = 'array' THEN t -> 'columns' ELSE '[]'::jsonb END) AS c),
    (SELECT string_agg(v.value, ' ')
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t -> 'rows') = 'array' THEN t -> 'rows' ELSE '[]'::jsonb END) AS r,
            jsonb_each_text(CASE WHEN jsonb_typeof(r) = 'object' THEN r ELSE '{}'::jsonb END) AS v))
$$;

-- The words of an array of objects: field `field` of each.
CREATE FUNCTION app.items_visible_text(items jsonb, field text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT string_agg(i ->> field, ' ') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(items) = 'array' THEN items ELSE '[]'::jsonb END) AS i
$$;

-- What the person saw of one part of a stored message (Mastra's form 2): the text, or a block of the
-- interface; NULL for anything else. Never an error: it runs inside Mastra's writes.
CREATE FUNCTION app.part_visible_text(part jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  call jsonb;
  args jsonb;
  result jsonb;
BEGIN
  IF jsonb_typeof(part) IS DISTINCT FROM 'object' THEN
    RETURN NULL;
  END IF;
  IF part ->> 'type' = 'text' THEN
    RETURN part ->> 'text';
  END IF;
  IF part ->> 'type' IS DISTINCT FROM 'tool-invocation' THEN
    RETURN NULL;
  END IF;
  call := part -> 'toolInvocation';
  IF jsonb_typeof(call) IS DISTINCT FROM 'object' OR call ->> 'state' IS DISTINCT FROM 'result' THEN
    RETURN NULL;
  END IF;
  result := call -> 'result';
  -- A call that failed its check returns { error: true, message } and draws nothing.
  IF jsonb_typeof(result) = 'object' AND result -> 'error' = 'true'::jsonb THEN
    RETURN NULL;
  END IF;
  args := CASE WHEN jsonb_typeof(call -> 'args') = 'object' THEN call -> 'args' ELSE '{}'::jsonb END;
  CASE call ->> 'toolName'
    WHEN 'show_table' THEN
      RETURN app.table_visible_text(args);
    WHEN 'show_card' THEN
      RETURN concat_ws(E'\n', args ->> 'title', args ->> 'subtitle', app.items_visible_text(args -> 'fields', 'label'), app.items_visible_text(args -> 'fields', 'value'));
    WHEN 'show_chart' THEN
      RETURN concat_ws(E'\n', args ->> 'title',
        (SELECT string_agg(l, ' ') FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(args -> 'labels') = 'array' THEN args -> 'labels' ELSE '[]'::jsonb END) AS l),
        app.items_visible_text(args -> 'series', 'name'));
    WHEN 'ask_choice' THEN
      RETURN concat_ws(E'\n', args ->> 'question', app.items_visible_text(args -> 'options', 'label'));
    WHEN 'ask_form' THEN
      RETURN concat_ws(E'\n', args ->> 'title', app.items_visible_text(args -> 'fields', 'label'));
    WHEN 'show_file' THEN
      RETURN coalesce(result ->> 'name', regexp_replace(args ->> 'path', '^.*/', ''));
    ELSE
      -- A tool whose result is a table: the chat draws it under the line of the call.
      IF jsonb_typeof(result) = 'object' AND jsonb_typeof(result -> 'table') = 'object' THEN
        RETURN app.table_visible_text(result -> 'table');
      END IF;
      RETURN NULL;
  END CASE;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- The text of a message as the search reads it: its visible parts in order, joined by a line break.
CREATE OR REPLACE FUNCTION app.message_visible_text(content text) RETURNS text
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
  SELECT string_agg(piece, E'\n' ORDER BY n)
    INTO joined
    FROM jsonb_array_elements(parts) WITH ORDINALITY AS p(part, n), app.part_visible_text(p.part) AS piece
   WHERE piece IS NOT NULL AND piece <> '';
  RETURN coalesce(joined, '');
EXCEPTION WHEN OTHERS THEN
  RETURN '';
END;
$$;

-- Messages already kept get their blocks now. Mastra makes its tables after our migrations: on a new
-- installation there is nothing yet. The dictionary of words is built anew at every start of the server
-- (core/search/message-texts.ts).
DO $$
BEGIN
  IF to_regclass('mastra.mastra_messages') IS NOT NULL THEN
    UPDATE app.message_texts t
       SET text = app.message_visible_text(m.content)
      FROM mastra.mastra_messages m
     WHERE m.id = t.message_id AND t.text IS DISTINCT FROM app.message_visible_text(m.content);
  END IF;
END;
$$;
