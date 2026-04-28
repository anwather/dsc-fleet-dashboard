/**
 * Shared DTOs used by both apps/api and apps/web.
 *
 * Keep this module dependency-light: only zod for schemas. Anything
 * Node-specific or Prisma-specific belongs in apps/api.
 */
import { z } from 'zod';

// -----------------------------------------------------------------------------
// Enums (kept in sync with Prisma schema)
// -----------------------------------------------------------------------------
export const ServerStatus = z.enum([
  'pending',
  'provisioning',
  'ready',
  'error',
  'offline',
]);
export type ServerStatus = z.infer<typeof ServerStatus>;

export const AssignmentLifecycleState = z.enum([
  'active',
  'removing',
  'removed',
  'removal_expired',
]);
export type AssignmentLifecycleState = z.infer<typeof AssignmentLifecycleState>;

export const AssignmentPrereqStatus = z.enum([
  'unknown',
  'installing',
  'ready',
  'failed',
]);
export type AssignmentPrereqStatus = z.infer<typeof AssignmentPrereqStatus>;

export const AssignmentLastStatus = z.enum([
  'success',
  'drift',
  'error',
  'never',
]);
export type AssignmentLastStatus = z.infer<typeof AssignmentLastStatus>;

export const JobType = z.enum([
  'provision',
  'prereq-install',
  'module-install',
  'config-apply',
  'uninstall-config',
]);
export type JobType = z.infer<typeof JobType>;

export const JobStatus = z.enum([
  'queued',
  'running',
  'success',
  'failed',
  'cancelled',
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const ActorType = z.enum(['ui', 'agent', 'system']);
export type ActorType = z.infer<typeof ActorType>;

// -----------------------------------------------------------------------------
// Required-module DTO (parser output)
// -----------------------------------------------------------------------------
export const RequiredModule = z.object({
  name: z.string(),
  minVersion: z.string().optional(),
});
export type RequiredModule = z.infer<typeof RequiredModule>;

export const ParsedResource = z.object({
  type: z.string(),
  name: z.string().optional(),
});
export type ParsedResource = z.infer<typeof ParsedResource>;

export const YamlParseResult = z.object({
  requiredModules: z.array(RequiredModule),
  parsedResources: z.array(ParsedResource),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  sourceSha256: z.string(),
  semanticSha256: z.string(),
});
export type YamlParseResult = z.infer<typeof YamlParseResult>;

// -----------------------------------------------------------------------------
// Server DTOs
// -----------------------------------------------------------------------------
export const ServerSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  azureSubscriptionId: z.string(),
  azureResourceGroup: z.string(),
  azureVmName: z.string(),
  status: ServerStatus,
  lastHeartbeatAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  hostname: z.string().nullable(),
  osCaption: z.string().nullable(),
  osVersion: z.string().nullable(),
  labels: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  runAs: z
    .object({
      kind: z.enum(['system', 'password', 'gmsa']),
      user: z.string().nullable(),
      updatedAt: z.string().datetime().nullable(),
    })
    .optional(),
});
export type ServerSummary = z.infer<typeof ServerSummary>;

export const ServerCreate = z.object({
  azureSubscriptionId: z.string().min(1),
  azureResourceGroup: z.string().min(1),
  azureVmName: z.string().min(1),
  name: z.string().min(1).optional(),
  labels: z.record(z.string(), z.unknown()).optional(),
});
export type ServerCreate = z.infer<typeof ServerCreate>;

export const ProvisionTokenResponse = z.object({
  token: z.string(),
  expiresAt: z.string().datetime(),
});
export type ProvisionTokenResponse = z.infer<typeof ProvisionTokenResponse>;

// -----------------------------------------------------------------------------
// Config DTOs
// -----------------------------------------------------------------------------
export const ConfigRevisionSummary = z.object({
  id: z.string().uuid(),
  configId: z.string().uuid(),
  version: z.number().int().positive(),
  sourceSha256: z.string(),
  semanticSha256: z.string(),
  requiredModules: z.array(RequiredModule),
  parsedResources: z.array(ParsedResource),
  createdAt: z.string().datetime(),
});
export type ConfigRevisionSummary = z.infer<typeof ConfigRevisionSummary>;

export const ConfigRevisionDetail = ConfigRevisionSummary.extend({
  yamlBody: z.string(),
});
export type ConfigRevisionDetail = z.infer<typeof ConfigRevisionDetail>;

export const ConfigSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  currentRevision: ConfigRevisionSummary.nullable(),
  assignmentCount: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ConfigSummary = z.infer<typeof ConfigSummary>;

export const ConfigCreate = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  yamlBody: z.string().min(1),
});
export type ConfigCreate = z.infer<typeof ConfigCreate>;

export const ConfigUpdate = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  yamlBody: z.string().min(1).optional(),
});
export type ConfigUpdate = z.infer<typeof ConfigUpdate>;

// -----------------------------------------------------------------------------
// Assignment DTOs
// -----------------------------------------------------------------------------
export const AssignmentSummary = z.object({
  id: z.string().uuid(),
  serverId: z.string().uuid(),
  configId: z.string().uuid(),
  pinnedRevisionId: z.string().uuid().nullable(),
  generation: z.number().int().positive(),
  intervalMinutes: z.number().int().positive(),
  enabled: z.boolean(),
  lifecycleState: AssignmentLifecycleState,
  prereqStatus: AssignmentPrereqStatus,
  lastStatus: AssignmentLastStatus,
  lastExitCode: z.number().int().nullable(),
  nextDueAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  lastFailureAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  // Optional joined view fields
  configName: z.string().optional(),
  serverName: z.string().optional(),
  // Resolved config revision the agent will apply: pinnedRevision.version
  // when pinned, else config.currentRevision.version. Null when the config
  // has no revisions yet.
  revisionVersion: z.number().int().positive().nullable().optional(),
  // Latest published revision version on the underlying config. When
  // greater than `revisionVersion`, the UI surfaces an "update available"
  // affordance so the user can opt-in.
  latestRevisionVersion: z.number().int().positive().nullable().optional(),
  // Revision version of the most recent run result. When < revisionVersion
  // (i.e. an upgrade has been pinned but no run has occurred against the new
  // revision yet), the UI surfaces a "pending vN" badge so the user can see
  // the upgrade is in flight.
  lastRunRevisionVersion: z.number().int().positive().nullable().optional(),
});
export type AssignmentSummary = z.infer<typeof AssignmentSummary>;

export const AssignmentCreate = z.object({
  serverId: z.string().uuid(),
  configId: z.string().uuid(),
  intervalMinutes: z.number().int().positive().optional(),
});
export type AssignmentCreate = z.infer<typeof AssignmentCreate>;

export const AssignmentUpdate = z.object({
  intervalMinutes: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
  pinnedRevisionId: z.string().uuid().nullable().optional(),
});
export type AssignmentUpdate = z.infer<typeof AssignmentUpdate>;

// -----------------------------------------------------------------------------
// Job DTO
// -----------------------------------------------------------------------------
export const JobSummary = z.object({
  id: z.string().uuid(),
  serverId: z.string().uuid().nullable(),
  type: JobType,
  status: JobStatus,
  payload: z.record(z.string(), z.unknown()),
  log: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  requestedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
});
export type JobSummary = z.infer<typeof JobSummary>;

// -----------------------------------------------------------------------------
// Run result + module + audit DTOs
// -----------------------------------------------------------------------------
export const RunResultSummary = z.object({
  id: z.string().uuid(),
  assignmentId: z.string().uuid(),
  serverId: z.string().uuid(),
  configRevisionId: z.string().uuid(),
  generation: z.number().int(),
  runId: z.string().uuid(),
  exitCode: z.number().int(),
  hadErrors: z.boolean(),
  inDesiredState: z.boolean(),
  durationMs: z.number().int(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  dscOutput: z.unknown().optional(),
});
export type RunResultSummary = z.infer<typeof RunResultSummary>;

export const ServerModuleSummary = z.object({
  serverId: z.string().uuid(),
  name: z.string(),
  installedVersion: z.string(),
  discoveredAt: z.string().datetime(),
});
export type ServerModuleSummary = z.infer<typeof ServerModuleSummary>;

export const AuditEventSummary = z.object({
  id: z.string().uuid(),
  eventType: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  actorType: ActorType,
  actorId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type AuditEventSummary = z.infer<typeof AuditEventSummary>;

// -----------------------------------------------------------------------------
// WebSocket envelope
// -----------------------------------------------------------------------------
export const WsEvent = z.object({
  topic: z.string(),
  type: z.string(),
  payload: z.unknown(),
  ts: z.string().datetime(),
});
export type WsEvent = z.infer<typeof WsEvent>;
