-- One-time run-as credential drop. See AgentCredential model in schema.prisma
-- for the full flow description.
--
-- `iv`, `ciphertext`, `auth_tag` default to empty bytea so gMSA-kind rows
-- (which carry no encrypted material) can be inserted without specifying them.

CREATE TABLE "agent_credentials" (
    "id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "job_id" UUID,
    "provision_token" TEXT NOT NULL,
    "url_token" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "iv" BYTEA NOT NULL DEFAULT '\x'::bytea,
    "ciphertext" BYTEA NOT NULL DEFAULT '\x'::bytea,
    "auth_tag" BYTEA NOT NULL DEFAULT '\x'::bytea,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_credentials_url_token_key" ON "agent_credentials" ("url_token");
CREATE INDEX "agent_credentials_server_id_idx" ON "agent_credentials" ("server_id");
CREATE INDEX "agent_credentials_expires_at_idx" ON "agent_credentials" ("expires_at");

ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_server_id_fkey"
    FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
