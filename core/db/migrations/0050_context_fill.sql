-- How full a conversation is (spec, section 8.34; decisions of the owner 25.11.2026).
--
-- The size of the context of a chat model, in tokens: the admin's number, else the one the gateway's model map
-- knows, else none — and without it the chat shows no indicator. Recognition models have none.
ALTER TABLE app.models
  ADD COLUMN max_input_tokens integer
  CONSTRAINT models_max_input_tokens_check CHECK (max_input_tokens IS NULL OR (max_input_tokens > 0 AND kind = 'chat'));

-- The last call of the model of a conversation's agent: what went in and what came out, as the provider counted it.
-- One row per conversation, written after every successful call; the model is kept by id only — the size of its
-- context is read when the indicator asks, so a size written later turns the indicator on for older conversations.
CREATE TABLE app.thread_context (
  thread_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app."user" ("id") ON DELETE CASCADE,
  model_id text NOT NULL,
  tokens integer NOT NULL CHECK (tokens >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
