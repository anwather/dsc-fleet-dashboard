-- Partial unique index: only one active or removing assignment may exist for a
-- given (server_id, config_id) pair. Removed and removal_expired rows are
-- excluded so that a config can be re-assigned to the same server (the new row
-- gets a higher `generation`).
--
-- This index cannot be expressed in the Prisma schema, hence the manual
-- migration.

CREATE UNIQUE INDEX "uniq_active_assignment"
  ON "assignments" ("server_id", "config_id")
  WHERE "lifecycle_state" IN ('active', 'removing');
