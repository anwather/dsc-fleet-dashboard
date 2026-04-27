-- CreateEnum
CREATE TYPE "ServerStatus" AS ENUM ('pending', 'provisioning', 'ready', 'error', 'offline');

-- CreateEnum
CREATE TYPE "AssignmentLifecycleState" AS ENUM ('active', 'removing', 'removed', 'removal_expired');

-- CreateEnum
CREATE TYPE "AssignmentPrereqStatus" AS ENUM ('unknown', 'installing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "AssignmentLastStatus" AS ENUM ('success', 'drift', 'error', 'never');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('provision', 'prereq-install', 'module-install', 'config-apply', 'uninstall-config');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'running', 'success', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('ui', 'agent', 'system');

-- CreateTable
CREATE TABLE "servers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "azure_subscription_id" TEXT NOT NULL,
    "azure_resource_group" TEXT NOT NULL,
    "azure_vm_name" TEXT NOT NULL,
    "agent_id" UUID NOT NULL,
    "hostname" TEXT,
    "os_caption" TEXT,
    "os_version" TEXT,
    "status" "ServerStatus" NOT NULL DEFAULT 'pending',
    "last_heartbeat_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "labels" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_keys" (
    "id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "key_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "agent_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_modules" (
    "server_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "installed_version" TEXT NOT NULL,
    "discovered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_modules_pkey" PRIMARY KEY ("server_id","name")
);

-- CreateTable
CREATE TABLE "configs" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "current_revision_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config_revisions" (
    "id" UUID NOT NULL,
    "config_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "yaml_body" TEXT NOT NULL,
    "source_sha256" TEXT NOT NULL,
    "semantic_sha256" TEXT NOT NULL,
    "required_modules" JSONB NOT NULL DEFAULT '[]',
    "parsed_resources" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "config_id" UUID NOT NULL,
    "pinned_revision_id" UUID,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "interval_minutes" INTEGER NOT NULL DEFAULT 15,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lifecycle_state" "AssignmentLifecycleState" NOT NULL DEFAULT 'active',
    "prereq_status" "AssignmentPrereqStatus" NOT NULL DEFAULT 'unknown',
    "next_due_at" TIMESTAMPTZ(6),
    "last_run_at" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "last_failure_at" TIMESTAMPTZ(6),
    "last_status" "AssignmentLastStatus" NOT NULL DEFAULT 'never',
    "last_exit_code" INTEGER,
    "removal_requested_at" TIMESTAMPTZ(6),
    "removal_ack_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "removed_at" TIMESTAMPTZ(6),

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "server_id" UUID,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "log" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_results" (
    "id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "config_revision_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "run_id" UUID NOT NULL,
    "exit_code" INTEGER NOT NULL,
    "had_errors" BOOLEAN NOT NULL,
    "in_desired_state" BOOLEAN NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "dsc_output" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "run_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "servers_agent_id_key" ON "servers"("agent_id");

-- CreateIndex
CREATE INDEX "servers_status_idx" ON "servers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "servers_azure_subscription_id_azure_resource_group_azure_vm_key" ON "servers"("azure_subscription_id", "azure_resource_group", "azure_vm_name");

-- CreateIndex
CREATE INDEX "agent_keys_server_id_idx" ON "agent_keys"("server_id");

-- CreateIndex
CREATE INDEX "agent_keys_key_hash_idx" ON "agent_keys"("key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "configs_current_revision_id_key" ON "configs"("current_revision_id");

-- CreateIndex
CREATE INDEX "config_revisions_config_id_idx" ON "config_revisions"("config_id");

-- CreateIndex
CREATE UNIQUE INDEX "config_revisions_config_id_version_key" ON "config_revisions"("config_id", "version");

-- CreateIndex
CREATE INDEX "assignments_server_id_idx" ON "assignments"("server_id");

-- CreateIndex
CREATE INDEX "assignments_config_id_idx" ON "assignments"("config_id");

-- CreateIndex
CREATE INDEX "assignments_lifecycle_state_idx" ON "assignments"("lifecycle_state");

-- CreateIndex
CREATE INDEX "assignments_next_due_at_idx" ON "assignments"("next_due_at");

-- CreateIndex
CREATE INDEX "jobs_server_id_idx" ON "jobs"("server_id");

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "jobs_type_idx" ON "jobs"("type");

-- CreateIndex
CREATE INDEX "run_results_assignment_id_idx" ON "run_results"("assignment_id");

-- CreateIndex
CREATE INDEX "run_results_server_id_idx" ON "run_results"("server_id");

-- CreateIndex
CREATE INDEX "run_results_finished_at_idx" ON "run_results"("finished_at");

-- CreateIndex
CREATE INDEX "audit_events_entity_id_idx" ON "audit_events"("entity_id");

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_idx" ON "audit_events"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_events_created_at_idx" ON "audit_events"("created_at");

-- AddForeignKey
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_modules" ADD CONSTRAINT "server_modules_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configs" ADD CONSTRAINT "configs_current_revision_id_fkey" FOREIGN KEY ("current_revision_id") REFERENCES "config_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "config_revisions" ADD CONSTRAINT "config_revisions_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_pinned_revision_id_fkey" FOREIGN KEY ("pinned_revision_id") REFERENCES "config_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_results" ADD CONSTRAINT "run_results_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_results" ADD CONSTRAINT "run_results_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_results" ADD CONSTRAINT "run_results_config_revision_id_fkey" FOREIGN KEY ("config_revision_id") REFERENCES "config_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
