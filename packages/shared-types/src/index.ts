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
});
export type ServerSummary = z.infer<typeof ServerSummary>;

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
