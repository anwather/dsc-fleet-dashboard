/**
 * UI-facing /api/assignments routes.
 *
 * Lifecycle invariants:
 *   - active     — agent is applying the config on its interval
 *   - removing   — uninstall requested; agent must ack within 15*intervalMinutes
 *   - removed    — agent ack'd
 *   - removal_expired — agent never ack'd (scheduler-driven transition)
 *
 * Re-creating an assignment for the same (server, config) after it was removed
 * bumps the `generation` so old run results / agent retries are ignored.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { loadEnv } from '../lib/env.js';
import { reconcileAssignmentPrereq } from '../services/scheduler.js';

const AssignmentCreate = z.object({
  serverId: z.string().uuid(),
  configId: z.string().uuid(),
  intervalMinutes: z.number().int().positive().optional(),
});

const AssignmentUpdate = z.object({
  intervalMinutes: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
  pinnedRevisionId: z.string().uuid().nullable().optional(),
});

interface AssignmentLite {
  id: string;
  serverId: string;
  configId: string;
  pinnedRevisionId: string | null;
  generation: number;
  intervalMinutes: number;
  enabled: boolean;
  lifecycleState: string;
  prereqStatus: string;
  lastStatus: string;
  lastExitCode: number | null;
  nextDueAt: Date | null;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function shape(a: AssignmentLite) {
  return {
    id: a.id,
    serverId: a.serverId,
    configId: a.configId,
    pinnedRevisionId: a.pinnedRevisionId,
    generation: a.generation,
    intervalMinutes: a.intervalMinutes,
    enabled: a.enabled,
    lifecycleState: a.lifecycleState,
    prereqStatus: a.prereqStatus,
    lastStatus: a.lastStatus,
    lastExitCode: a.lastExitCode,
    nextDueAt: a.nextDueAt?.toISOString() ?? null,
    lastRunAt: a.lastRunAt?.toISOString() ?? null,
    lastSuccessAt: a.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: a.lastFailureAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

const route: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { serverId?: string; configId?: string; lifecycleState?: string } }>(
    '/',
    async (req, reply) => {
      const where: Record<string, unknown> = {};
      if (req.query.serverId) where.serverId = req.query.serverId;
      if (req.query.configId) where.configId = req.query.configId;
      if (req.query.lifecycleState) where.lifecycleState = req.query.lifecycleState;
      const rows = await prisma.assignment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          server: { select: { name: true } },
          config: { select: { name: true, currentRevision: { select: { version: true } } } },
          pinnedRevision: { select: { version: true } },
        },
      });
      // Resolve the most recent run result per assignment in a single query so
      // the UI can detect "pending upgrade" (pinned revision > last-run revision).
      const lastRunByAssignment = new Map<string, number>();
      if (rows.length > 0) {
        const latest = await prisma.runResult.findMany({
          where: { assignmentId: { in: rows.map((r) => r.id) } },
          orderBy: [{ assignmentId: 'asc' }, { finishedAt: 'desc' }],
          distinct: ['assignmentId'],
          select: { assignmentId: true, configRevision: { select: { version: true } } },
        });
        for (const r of latest) {
          if (r.configRevision?.version != null) {
            lastRunByAssignment.set(r.assignmentId, r.configRevision.version);
          }
        }
      }
      return reply.send(
        rows.map((a) => ({
          ...shape(a),
          serverName: a.server?.name,
          configName: a.config?.name,
          revisionVersion:
            a.pinnedRevision?.version ?? a.config?.currentRevision?.version ?? null,
          latestRevisionVersion: a.config?.currentRevision?.version ?? null,
          lastRunRevisionVersion: lastRunByAssignment.get(a.id) ?? null,
        })),
      );
    },
  );

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const a = await prisma.assignment.findUnique({
      where: { id: req.params.id },
      include: {
        server: { select: { name: true } },
        config: { select: { name: true, currentRevision: { select: { version: true } } } },
        pinnedRevision: { select: { version: true } },
      },
    });
    if (!a) return reply.status(404).send({ error: 'NotFound' });
    const lastRun = await prisma.runResult.findFirst({
      where: { assignmentId: a.id },
      orderBy: { finishedAt: 'desc' },
      select: { configRevision: { select: { version: true } } },
    });
    return reply.send({
      ...shape(a),
      serverName: a.server?.name,
      configName: a.config?.name,
      revisionVersion: a.pinnedRevision?.version ?? a.config?.currentRevision?.version ?? null,
      latestRevisionVersion: a.config?.currentRevision?.version ?? null,
      lastRunRevisionVersion: lastRun?.configRevision?.version ?? null,
    });
  });

  app.post('/', async (req, reply) => {
    const env = loadEnv();
    const body = AssignmentCreate.parse(req.body);

    const server = await prisma.server.findUnique({ where: { id: body.serverId } });
    if (!server || server.deletedAt) {
      return reply.status(404).send({ error: 'NotFound', message: 'server not found' });
    }
    const config = await prisma.config.findUnique({ where: { id: body.configId } });
    if (!config || config.deletedAt) {
      return reply.status(404).send({ error: 'NotFound', message: 'config not found' });
    }

    // The partial unique index lets us re-assign after removal — but we need
    // generation = max(prior gen) + 1 so the agent ignores stale results.
    const prior = await prisma.assignment.findFirst({
      where: { serverId: body.serverId, configId: body.configId },
      orderBy: { generation: 'desc' },
      select: { generation: true, lifecycleState: true },
    });
    if (prior && (prior.lifecycleState === 'active' || prior.lifecycleState === 'removing')) {
      return reply
        .status(409)
        .send({ error: 'Conflict', message: 'assignment already exists for this server+config' });
    }
    const generation = (prior?.generation ?? 0) + 1;
    const intervalMinutes = body.intervalMinutes ?? env.DEFAULT_ASSIGNMENT_INTERVAL_MINUTES;

    // nextDueAt = now so the next runner cycle picks the assignment up
    // immediately instead of waiting one full interval.
    const created = await prisma.assignment.create({
      data: {
        serverId: body.serverId,
        configId: body.configId,
        generation,
        intervalMinutes,
        // Pin to the current revision at create time so future revisions don't
        // auto-apply. The user can opt-in to upgrades via PATCH pinnedRevisionId.
        pinnedRevisionId: config.currentRevisionId ?? null,
        nextDueAt: new Date(),
      },
    });

    await reconcileAssignmentPrereq(created.id);

    req.audit({
      eventType: 'assignment.created',
      entityType: 'assignment',
      entityId: created.id,
      payload: { serverId: body.serverId, configId: body.configId, generation },
    });
    app.broadcast(`server:${body.serverId}`, 'assignment.created', {
      assignmentId: created.id,
      configId: body.configId,
      generation,
    });

    const fresh = await prisma.assignment.findUnique({ where: { id: created.id } });
    return reply.status(201).send(shape(fresh!));
  });

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const body = AssignmentUpdate.parse(req.body);
    const a = await prisma.assignment.findUnique({ where: { id: req.params.id } });
    if (!a) return reply.status(404).send({ error: 'NotFound' });
    if (a.lifecycleState !== 'active') {
      return reply
        .status(409)
        .send({ error: 'Conflict', message: `cannot edit assignment in state ${a.lifecycleState}` });
    }

    // If pinnedRevisionId is supplied, validate it belongs to this config.
    if (body.pinnedRevisionId !== undefined && body.pinnedRevisionId !== null) {
      const rev = await prisma.configRevision.findUnique({
        where: { id: body.pinnedRevisionId },
        select: { configId: true },
      });
      if (!rev || rev.configId !== a.configId) {
        return reply
          .status(400)
          .send({ error: 'BadRequest', message: 'pinnedRevisionId does not belong to this config' });
      }
    }

    const newPinned = body.pinnedRevisionId !== undefined ? body.pinnedRevisionId : a.pinnedRevisionId;
    const revisionChanged = newPinned !== a.pinnedRevisionId;

    const updated = await prisma.assignment.update({
      where: { id: a.id },
      data: {
        intervalMinutes: body.intervalMinutes ?? a.intervalMinutes,
        enabled: body.enabled ?? a.enabled,
        pinnedRevisionId: newPinned,
        // Bump generation + force re-due so the agent picks up the new revision
        // on its next poll instead of waiting for the current interval.
        ...(revisionChanged ? { generation: a.generation + 1, nextDueAt: new Date() } : {}),
      },
    });
    req.audit({
      eventType: 'assignment.updated',
      entityType: 'assignment',
      entityId: a.id,
      payload: body as Record<string, unknown>,
    });
    app.broadcast(`server:${a.serverId}`, 'assignment.updated', {
      assignmentId: a.id,
    });
    return reply.send(shape(updated));
  });

  // Soft uninstall — flip to 'removing' so the agent runs uninstall on its next poll.
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const a = await prisma.assignment.findUnique({ where: { id: req.params.id } });
    if (!a) return reply.status(404).send({ error: 'NotFound' });
    if (a.lifecycleState !== 'active') {
      return reply
        .status(409)
        .send({ error: 'Conflict', message: `cannot remove assignment in state ${a.lifecycleState}` });
    }
    const updated = await prisma.assignment.update({
      where: { id: a.id },
      data: { lifecycleState: 'removing', removalRequestedAt: new Date() },
    });
    req.audit({
      eventType: 'assignment.removal.requested',
      entityType: 'assignment',
      entityId: a.id,
      payload: {},
    });
    app.broadcast(`server:${a.serverId}`, 'assignment.removing', {
      assignmentId: a.id,
    });
    return reply.send(shape(updated));
  });

  // Force-remove — bypass agent ack. Used when the agent is permanently gone.
  app.post<{ Params: { id: string } }>('/:id/force-remove', async (req, reply) => {
    const a = await prisma.assignment.findUnique({ where: { id: req.params.id } });
    if (!a) return reply.status(404).send({ error: 'NotFound' });
    if (a.lifecycleState === 'removed' || a.lifecycleState === 'removal_expired') {
      return reply.status(409).send({
        error: 'Conflict',
        message: `assignment already in terminal state ${a.lifecycleState}`,
      });
    }
    const now = new Date();
    const updated = await prisma.assignment.update({
      where: { id: a.id },
      data: {
        lifecycleState: 'removal_expired',
        removalRequestedAt: a.removalRequestedAt ?? now,
        removedAt: now,
      },
    });
    req.audit({
      eventType: 'assignment.force_removed',
      entityType: 'assignment',
      entityId: a.id,
      payload: {},
    });
    app.broadcast(`server:${a.serverId}`, 'assignment.removed', {
      assignmentId: a.id,
      forced: true,
    });
    return reply.send(shape(updated));
  });
};

export default route;
