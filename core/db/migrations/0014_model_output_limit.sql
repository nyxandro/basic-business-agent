-- The longest answer a chat model on a key may give, in tokens (spec, section 8.19; decision of the
-- owner 15.11.2026). Taken from the gateway's model map when the model is added, or given by the
-- admin when the gateway does not know the model; the gateway deployment carries it as max_tokens.
-- Recognition and subscription models have none. Models added earlier stay NULL until the server
-- fills them from the gateway at start.
ALTER TABLE app.models
  ADD COLUMN max_output_tokens integer
  CONSTRAINT models_max_output_tokens_check CHECK (max_output_tokens IS NULL OR (max_output_tokens > 0 AND connection = 'api_key' AND kind = 'chat'));
