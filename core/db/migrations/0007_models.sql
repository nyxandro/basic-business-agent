-- Models, provider keys and the organisation's model settings (spec, sections 8.1 and 17.4):
-- the admin adds them in «Нейросеть», our database is the source of truth, the server copies them
-- into LiteLLM. Prices are roubles per 1 million tokens (an image and a minute — roubles each).
CREATE TABLE app.models (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  kind text NOT NULL CHECK (kind IN ('chat', 'transcription')),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  connection text NOT NULL CHECK (connection IN ('api_key', 'chatgpt')),
  provider_model text NOT NULL CHECK (length(provider_model) BETWEEN 1 AND 200),
  api_base text,
  vision boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  price_input numeric(14, 4) CHECK (price_input >= 0),
  price_output numeric(14, 4) CHECK (price_output >= 0),
  price_cache_read numeric(14, 4) CHECK (price_cache_read >= 0),
  price_cache_write numeric(14, 4) CHECK (price_cache_write >= 0),
  price_reasoning numeric(14, 4) CHECK (price_reasoning >= 0),
  price_image numeric(14, 4) CHECK (price_image >= 0),
  price_per_minute numeric(14, 4) CHECK (price_per_minute >= 0),
  created_by text REFERENCES app."user" ("id") ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- An empty price would let LiteLLM fall back to its own dollar prices, so a model on a key has
  -- every token price, or (recognition only) a price per minute; a subscription has none.
  CONSTRAINT models_prices CHECK (
    CASE connection
      WHEN 'chatgpt' THEN kind = 'chat'
        AND num_nulls(price_input, price_output, price_cache_read, price_cache_write, price_reasoning, price_image, price_per_minute) = 7
      ELSE (num_nonnulls(price_input, price_output, price_cache_read, price_cache_write, price_reasoning, price_image) = 6 AND price_per_minute IS NULL)
        OR (kind = 'transcription' AND price_per_minute IS NOT NULL
            AND num_nulls(price_input, price_output, price_cache_read, price_cache_write, price_reasoning, price_image) = 6)
    END
  )
);

-- Keys of the providers, not to be confused with app.model_keys (employees' LiteLLM keys).
CREATE TABLE app.model_provider_keys (
  id text PRIMARY KEY CHECK (id ~ '^k-[0-9a-f]{8}$'),
  model_id text NOT NULL REFERENCES app.models (id) ON DELETE CASCADE,
  key_ciphertext bytea NOT NULL,
  key_iv bytea NOT NULL,
  key_version integer NOT NULL,
  key_last4 text NOT NULL CHECK (length(key_last4) <= 4),
  created_by text REFERENCES app."user" ("id") ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_provider_keys_model_idx ON app.model_provider_keys (model_id);

CREATE TABLE app.model_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  primary_model_id text REFERENCES app.models (id) ON DELETE SET NULL,
  fallback_model_id text REFERENCES app.models (id) ON DELETE SET NULL,
  transcription_model_id text REFERENCES app.models (id) ON DELETE SET NULL,
  agents_choose_model boolean NOT NULL DEFAULT false,
  updated_by text REFERENCES app."user" ("id") ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_settings_fallback_differs CHECK (fallback_model_id IS DISTINCT FROM primary_model_id OR fallback_model_id IS NULL)
);
CREATE INDEX model_settings_primary_idx ON app.model_settings (primary_model_id);
CREATE INDEX model_settings_fallback_idx ON app.model_settings (fallback_model_id);
CREATE INDEX model_settings_transcription_idx ON app.model_settings (transcription_model_id);
INSERT INTO app.model_settings DEFAULT VALUES;

-- An agent's own model now names a model of the admin's catalog; the ids of config/models.ts
-- that stage 1 kept here mean nothing in it.
UPDATE app.agent_overrides SET model_id = NULL;
ALTER TABLE app.agent_overrides
  ADD CONSTRAINT agent_overrides_model_fk FOREIGN KEY (model_id) REFERENCES app.models (id) ON DELETE SET NULL;
CREATE INDEX agent_overrides_model_idx ON app.agent_overrides (model_id);
