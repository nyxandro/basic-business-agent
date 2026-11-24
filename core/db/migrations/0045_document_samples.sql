-- «Добавление документов в референсы» in «Интерфейс» (docs/specs/[20.11.2026]-feedback-and-value.md, F6; owner 24.11): whether
-- the documents the agent made carry the heart that puts them into the knowledge base as samples. Off until an admin turns
-- it on (the owner's word); the samples already in the bases stay whatever it is.
ALTER TABLE app.interface_settings ADD COLUMN document_samples boolean NOT NULL DEFAULT false;
