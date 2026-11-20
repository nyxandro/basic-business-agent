-- The search finds the words of a widget the person saw (spec, section 8.31): texts, labels, titles, captions, the
-- cells of a table, the items of lists, the titles of tabs, the options of a choice, the words of the data a screen
-- shows — never ids, names of components, styles or codes of options. The same reading as core/widgets/visible-text.ts,
-- which the agent gets when it reads an old conversation. A call the server's check refused is not searched (the
-- check of `part_visible_text` before the tools).

CREATE FUNCTION app.widget_visible_text(args jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH ops AS (
    -- A model may write the list as one JSON string: it is the same list.
    SELECT o.op
      FROM jsonb_array_elements(CASE jsonb_typeof(args -> 'operations')
                                  WHEN 'array' THEN args -> 'operations'
                                  WHEN 'string' THEN (args ->> 'operations')::jsonb
                                  ELSE '[]'::jsonb END) AS o(op)
     WHERE jsonb_typeof(o.op) = 'object'
  ),
  components AS (
    SELECT coalesce(op #> '{createSurface,components}', op #> '{updateComponents,components}') AS c FROM ops
  ),
  objects AS (
    SELECT o.obj
      FROM components, jsonb_path_query(CASE WHEN jsonb_typeof(c) = 'array' THEN c ELSE '[]'::jsonb END, 'strict $.** ? (@.type() == "object")') AS o(obj)
  ),
  pairs AS (
    SELECT e.key AS k, e.value AS v FROM objects, jsonb_each(obj) AS e
  ),
  words AS (
    SELECT v #>> '{}' AS w FROM pairs
     WHERE k IN ('text', 'label', 'title', 'caption', 'subtitle', 'description', 'meta', 'message', 'placeholder', 'snippet', 'source', 'emptyLabel')
       AND jsonb_typeof(v) = 'string'
    UNION ALL
    -- The cells of a table written as lists of rows.
    SELECT cell.c #>> '{}'
      FROM pairs,
           jsonb_array_elements(CASE WHEN k = 'rows' AND jsonb_typeof(v) = 'array' THEN v ELSE '[]'::jsonb END) AS r(row_value),
           jsonb_array_elements(CASE WHEN jsonb_typeof(r.row_value) = 'array' THEN r.row_value ELSE '[]'::jsonb END) AS cell(c)
     WHERE jsonb_typeof(cell.c) IN ('string', 'number')
    UNION ALL
    -- The value of a template (formatString).
    SELECT v ->> 'value' FROM pairs WHERE k = 'args' AND jsonb_typeof(v -> 'value') = 'string'
    UNION ALL
    -- Lists whose items may be plain strings; the value of a list item is shown on its right.
    SELECT CASE WHEN jsonb_typeof(item.it) = 'string' THEN item.it #>> '{}' ELSE item.it ->> 'value' END
      FROM pairs, jsonb_array_elements(CASE WHEN k IN ('items', 'options', 'columns') AND jsonb_typeof(v) = 'array' THEN v ELSE '[]'::jsonb END) AS item(it)
     WHERE jsonb_typeof(item.it) = 'string' OR (k = 'items' AND jsonb_typeof(item.it -> 'value') IN ('string', 'number'))
    UNION ALL
    -- The words of the data a screen shows.
    SELECT s.word #>> '{}'
      FROM ops, jsonb_path_query(coalesce(op #> '{createSurface,dataModel}', op #> '{updateDataModel,value}', 'null'::jsonb), 'strict $.** ? (@.type() == "string")') AS s(word)
  )
  SELECT nullif(string_agg(trimmed, ' '), '')
    FROM (SELECT btrim(regexp_replace(regexp_replace(w, '\$\{[^}]*\}', ' ', 'g'), '\s+', ' ', 'g')) AS trimmed FROM words) AS t
   WHERE trimmed <> ''
$$;

-- The same reading of a part as in 0028, with widgets.
CREATE OR REPLACE FUNCTION app.part_visible_text(part jsonb) RETURNS text
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
    WHEN 'render_ui' THEN
      RETURN app.widget_visible_text(args);
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

-- Messages already kept get their widgets now. Mastra makes its tables after our migrations: on a new installation
-- there is nothing yet.
DO $$
BEGIN
  IF to_regclass('mastra.mastra_messages') IS NOT NULL THEN
    UPDATE app.message_texts t
       SET text = app.message_visible_text(m.content)
      FROM mastra.mastra_messages m
     WHERE m.id = t.message_id AND m.content LIKE '%render_ui%' AND t.text IS DISTINCT FROM app.message_visible_text(m.content);
  END IF;
END;
$$;
