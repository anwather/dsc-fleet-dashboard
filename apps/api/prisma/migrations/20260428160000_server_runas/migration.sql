-- Persist run-as configuration per Server so re-provisioning reuses it.
--
-- When `run_as_kind` is NULL the scheduled task on the agent is registered
-- as SYSTEM (current default). When set to 'password' the iv/ciphertext/
-- auth_tag columns hold AES-256-GCM-encrypted material under the API's
-- RUNAS_MASTER_KEY. When set to 'gmsa' those byte columns are empty.

ALTER TABLE "servers"
    ADD COLUMN "run_as_kind"         TEXT,
    ADD COLUMN "run_as_user"         TEXT,
    ADD COLUMN "run_as_iv"           BYTEA NOT NULL DEFAULT '\x'::bytea,
    ADD COLUMN "run_as_ciphertext"   BYTEA NOT NULL DEFAULT '\x'::bytea,
    ADD COLUMN "run_as_auth_tag"     BYTEA NOT NULL DEFAULT '\x'::bytea,
    ADD COLUMN "run_as_updated_at"   TIMESTAMPTZ(6);
