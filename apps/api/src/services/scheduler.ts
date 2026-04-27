/**
 * Periodic maintenance sweep — runs every 30s via node-cron.
 *
 * Responsibilities (none of these depend on agent activity):
 *   1. Mark servers offline if last_heartbeat_at is older than
 *      OFFLINE_MULTIPLIER * AGENT_POLL_DEFAULT_SECONDS.
 *   2. Expire stale removals — assignments stuck in 'removing' for
 *      longer than 15 * intervalMinutes flip to 'removal_expired'.
 *   3. Backfill next_due_at for freshly-created active assignments
 *      (createdAt + intervalMinutes).
 *   4. Reconcile prereq_status: any non-ready assignment whose
 *      requiredModules are now all present in server_modules flips to 'ready'.
 *   5. Re-fire queued jobs that nothing kicked off (jobs.reapStuckJobs).
 *
 * The scheduler does NOT execute DSC configs — that is the agent's job.
 */
import cron from 'node-cron';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { loadEnv } from '../lib/env.js';
import { reapStuckJobs } from './jobs.js';

interface RequiredModule {
  name: string;
  minVersion?: string;
}

let task: cron.ScheduledTask | null = null;
let appRef: FastifyInstance | null = null;

function broadcast(topic: string, type: string, payload: unknown): void {
  if (!appRef) return;
  try {
    appRef.broadcast(topic, type, payload);
  } catch (err) {
    logger.warn({ err, topic }, 'scheduler ws broadcast failed');
  }
}

// Compare semver-ish strings; missing minVersion => any installed version OK.
function meetsMinVersion(installed: string, min: string | undefined): boolean {
  if (!min) return true;
  const a = installed.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const b = min.split('.').map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return true;
}

async function markOffline(): Promise<void> {
  const env = loadEnv();
  const cutoff = new Date(Date.now() - env.OFFLINE_MULTIPLIER * env.AGENT_POLL_DEFAULT_SECONDS * 1000);
  const stale = await prisma.server.findMany({
    where: {
      deletedAt: null,
      status: { in: ['ready'] },
      lastHeartbeatAt: { lt: cutoff },
    },
    select: { id: true },
  });
  for (const s of stale) {
    await prisma.server.update({ where: { id: s.id }, data: { status: 'offline' } });
    broadcast(`server:${s.id}`, 'status', { status: 'offline' });
  }
  if (stale.length > 0) logger.debug({ count: stale.length }, 'scheduler: marked servers offline');
}

async function expireStaleRemovals(): Promise<void> {
  const removing = await prisma.assignment.findMany({
    where: { lifecycleState: 'removing', removalRequestedAt: { not: null } },
  });
  const now = Date.now();
  for (const a of removing) {
    const requestedAt = a.removalRequestedAt!.getTime();
    const ageMs = now - requestedAt;
    const cap = 15 * a.intervalMinutes * 60_000;
    if (ageMs > cap) {
      await prisma.assignment.update({
        where: { id: a.id },
        data: { lifecycleState: 'removal_expired', removedAt: new Date() },
      });
      broadcast(`server:${a.serverId}`, 'assignment.removal_expired', { assignmentId: a.id });
    }
  }
}

async function backfillNextDueAt(): Promise<void> {
  const pending = await prisma.assignment.findMany({
    where: { lifecycleState: 'active', nextDueAt: null },
    select: { id: true, createdAt: true, intervalMinutes: true },
  });
  for (const a of pending) {
    const next = new Date(a.createdAt.getTime() + a.intervalMinutes * 60_000);
    await prisma.assignment.update({
      where: { id: a.id },
      data: { nextDueAt: next },
    });
  }
}

async function reconcilePrereqStatus(): Promise<void> {
  const candidates = await prisma.assignment.findMany({
    where: {
      lifecycleState: 'active',
      prereqStatus: { not: 'ready' },
    },
    include: { config: { include: { currentRevision: true } } },
  });
  for (const a of candidates) {
    const rev = a.config.currentRevision;
    if (!rev) continue;
    const required = (rev.requiredModules as unknown as RequiredModule[]) ?? [];
    if (required.length === 0) {
      await prisma.assignment.update({ where: { id: a.id }, data: { prereqStatus: 'ready' } });
      broadcast(`server:${a.serverId}`, 'assignment.prereq_ready', { assignmentId: a.id });
      continue;
    }
    const installed = await prisma.serverModule.findMany({
      where: { serverId: a.serverId, name: { in: required.map((m) => m.name) } },
    });
    const allOk = required.every((req) => {
      const inst = installed.find((i) => i.name === req.name);
      return !!inst && meetsMinVersion(inst.installedVersion, req.minVersion);
    });
    if (allOk) {
      await prisma.assignment.update({ where: { id: a.id }, data: { prereqStatus: 'ready' } });
      broadcast(`server:${a.serverId}`, 'assignment.prereq_ready', { assignmentId: a.id });
    }
  }
}

async function tick(): Promise<void> {
  try {
    await markOffline();
    await expireStaleRemovals();
    await backfillNextDueAt();
    await reconcilePrereqStatus();
    await reapStuckJobs();
  } catch (err) {
    logger.error({ err }, 'scheduler tick failed');
  }
}

export function startScheduler(app: FastifyInstance<any, any, any, any, any>): void {
  appRef = app as unknown as FastifyInstance;
  if (task) return;
  // every 30s: */30 * * * * * (six fields)
  task = cron.schedule('*/30 * * * * *', () => void tick(), { scheduled: true });
  logger.info('scheduler started (every 30s)');
  // Run once immediately on boot to backfill stale state.
  void tick();
}

export function stopScheduler(): void {
  if (task) {
    task.stop();
    task = null;
  }
}

// Helper used by route handlers to immediately reconcile prereq for one assignment.
export async function reconcileAssignmentPrereq(assignmentId: string): Promise<void> {
  const a = await prisma.assignment.findUnique({
    where: { id: assignmentId },
    include: { config: { include: { currentRevision: true } } },
  });
  if (!a) return;
  const rev = a.config.currentRevision;
  if (!rev) {
    await prisma.assignment.update({ where: { id: a.id }, data: { prereqStatus: 'unknown' } });
    return;
  }
  const required = (rev.requiredModules as unknown as RequiredModule[]) ?? [];
  if (required.length === 0) {
    await prisma.assignment.update({ where: { id: a.id }, data: { prereqStatus: 'ready' } });
    return;
  }
  const installed = await prisma.serverModule.findMany({
    where: { serverId: a.serverId, name: { in: required.map((m) => m.name) } },
  });
  const allOk = required.every((req) => {
    const inst = installed.find((i) => i.name === req.name);
    return !!inst && meetsMinVersion(inst.installedVersion, req.minVersion);
  });
  if (allOk) {
    await prisma.assignment.update({ where: { id: a.id }, data: { prereqStatus: 'ready' } });
    return;
  }
  // Check whether a queued/running module-install job exists for the missing module(s).
  const missingNames = required
    .filter((req) => {
      const inst = installed.find((i) => i.name === req.name);
      return !inst || !meetsMinVersion(inst.installedVersion, req.minVersion);
    })
    .map((m) => m.name);
  const inflight = await prisma.job.findFirst({
    where: {
      serverId: a.serverId,
      type: 'module_install',
      status: { in: ['queued', 'running'] },
    },
  });
  if (inflight) {
    const inflightModules = ((inflight.payload as { modules?: { name: string }[] })?.modules ?? []).map((m) => m.name);
    if (missingNames.some((n) => inflightModules.includes(n))) {
      await prisma.assignment.update({ where: { id: a.id }, data: { prereqStatus: 'installing' } });
      return;
    }
  }
  await prisma.assignment.update({ where: { id: a.id }, data: { prereqStatus: 'unknown' } });
}
