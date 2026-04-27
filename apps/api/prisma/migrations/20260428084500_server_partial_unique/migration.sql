-- Replace the full-table unique on (azure_subscription_id, azure_resource_group,
-- azure_vm_name) with a *partial* unique that only applies to non-soft-deleted
-- rows. This lets the same Azure VM be re-added to the dashboard after it has
-- been removed (the soft-deleted row stays in place so its run history /
-- audit logs remain queryable).
--
-- This index cannot be expressed in the Prisma schema, hence the manual
-- migration. The Server model has a comment pointing back here.

DROP INDEX IF EXISTS "servers_azure_subscription_id_azure_resource_group_azure_vm_key";

CREATE UNIQUE INDEX "uniq_active_server_azure_target"
  ON "servers" ("azure_subscription_id", "azure_resource_group", "azure_vm_name")
  WHERE "deleted_at" IS NULL;
