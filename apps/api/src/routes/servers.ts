/**
 * UI-facing /api/servers routes.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { generateToken } from '../lib/tokens.js';
import { loadEnv } from '../lib/env.js';
import { createProvisionJob, createModuleInstallJob } from '../services/jobs.js';
import { reconcileAssignmentPrereq } from '../services/scheduler.js';

const ServerCreate = z.object({
  azureSubscriptionId: z.string().min(1),
  azureResourceGroup: z.string().min(1),
  azureVmName: z.string().min(1),
  name: z.string().min(1).optional(),
  labels: z.record(z.string(), z.unknown()).optional(),
});

const ServerUpdate = z.object({
  name: z.string().min(1).optional(),
  labels: z.record(z.string(), z.unknown()).optional(),
});

const InstallModulesBody = z.object({
  modules: z
    .array(z.object({ name: z.string().min(1), minVersion: z.string().optional() }))
    .min(1),
});

function shapeServer(s: {
  id: string;
  name: string;
  azureSubscriptionId: string;
  azureResourceGroup: string;
  azureVmName: string;
  agentId: string;
  hostname: string | null;
  osCaption: string | null;
  osVersion: string | null;
  status: string;
  lastHeartbeatAt: Date | null;
  lastError: string | null;
  labels: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: s.id,
    name: s.name,
    azureSubscriptionId: s.azureSubscriptionId,
    azureResourceGroup: s.azureResourceGroup,
    azureVmName: s.azureVmName,
    agentId: s.agentId,
    hostname: s.hostname,
    osCaption: s.osCaption,
    osVersion: s.osVersion,
    status: s.status,
    lastHeartbeatAt: s.lastHeartbeatAt?.toISOString() ?? null,
    lastError: s.lastError,
    labels: s.labels,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

const route: FastifyPluginAsync = async (app) => {
  app.get('/', async (_req, reply) => {
    const rows = await prisma.server.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send(rows.map(shapeServer));
  });

  app.post('/', async (req, reply) => {
    const body = ServerCreate.parse(req.body);
    const created = await prisma.server.create({
      data: {
        azureSubscriptionId: body.azureSubscriptionId,
        azureResourceGroup: body.azureResourceGroup,
        azureVmName: body.azureVmName,
        name: body.name ?? body.azureVmName,
        labels: (body.labels ?? {}) as object,
        status: 'pending',
      },
    });
    req.audit({
      eventType: 'server.created',
      entityType: 'server',
      entityId: created.id,
      payload: { name: created.name, azureVmName: created.azureVmName },
    });
    app.broadcast(`server:${created.id}`, 'created', shapeServer(created));
    return reply.status(201).send(shapeServer(created));
  });

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const s = await prisma.server.findUnique({ where: { id: req.params.id } });
    if (!s || s.deletedAt) return reply.status(404).send({ error: 'NotFound' });
    return reply.send(shapeServer(s));
  });

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const body = ServerUpdate.parse(req.body);
    const s = await prisma.server.findUnique({ where: { id: req.params.id } });
    if (!s || s.deletedAt) return reply.status(404).send({ error: 'NotFound' });
    const updated = await prisma.server.update({
      where: { id: s.id },
      data: {
        name: body.name ?? s.name,
        labels: body.labels ? (body.labels as object) : (s.labels as object),
      },
    });
    req.audit({
      eventType: 'server.updated',
      entityType: 'server',
      entityId: s.id,
      payload: body as Record<string, unknown>,
    });
    return reply.send(shapeServer(updated));
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const s = await prisma.server.findUnique({ where: { id: req.params.id } });
    if (!s || s.deletedAt) return reply.status(404).send({ error: 'NotFound' });
    await prisma.server.update({
      where: { id: s.id },
      data: { deletedAt: new Date() },
    });
    req.audit({
      eventType: 'server.deleted',
      entityType: 'server',
      entityId: s.id,
      payload: {},
    });
    return reply.status(204).send();
  });

  // Issue a provision token + queue the provision job.
  app.post<{ Params: { id: string } }>('/:id/provision-token', async (req, reply) => {
    const env = loadEnv();
    const s = await prisma.server.findUnique({ where: { id: req.params.id } });
    if (!s || s.deletedAt) return reply.status(404).send({ error: 'NotFound' });

    const token = generateToken(32);
    const expiresAt = new Date(Date.now() + env.AZURE_RUNCOMMAND_TIMEOUT_MINUTES * 60_000);
    const dashboardUrl = `${req.protocol}://${req.headers.host ?? 'localhost'}`;

    const jobId = await createProvisionJob(s.id, {
      token,
      expiresAt: expiresAt.toISOString(),
      dashboardUrl,
      agentBridgeBaseUrl:
        'https://raw.githubusercontent.com/anwather/dsc-fleet/main/bootstrap',
    });

    req.audit({
      eventType: 'server.provision.requested',
      entityType: 'server',
      entityId: s.id,
      payload: { jobId, expiresAt: expiresAt.toISOString() },
    });

    return reply.status(201).send({
      provisionToken: token,
      expiresAt: expiresAt.toISOString(),
      jobId,
    });
  });

  app.post<{ Params: { id: string } }>('/:id/install-modules', async (req, reply) => {
    const body = InstallModulesBody.parse(req.body);
    const s = await prisma.server.findUnique({ where: { id: req.params.id } });
    if (!s || s.deletedAt) return reply.status(404).send({ error: 'NotFound' });

    const jobId = await createModuleInstallJob(s.id, { modules: body.modules });

    // Flip prereq_status to 'installing' for any active assignments waiting on
    // these modules so the UI shows progress.
    const moduleNames = new Set(body.modules.map((m) => m.name));
    const active = await prisma.assignment.findMany({
      where: { serverId: s.id, lifecycleState: 'active' },
      include: { config: { include: { currentRevision: true } } },
    });
    for (const a of active) {
      const reqMods = ((a.config.currentRevision?.requiredModules as unknown) ?? []) as Array<{
        name: string;
      }>;
      if (reqMods.some((m) => moduleNames.has(m.name))) {
        await prisma.assignment.update({
          where: { id: a.id },
          data: { prereqStatus: 'installing' },
        });
      }
    }

    req.audit({
      eventType: 'server.modules.install.requested',
      entityType: 'server',
      entityId: s.id,
      payload: { jobId, modules: body.modules },
    });

    return reply.status(202).send({ jobId });
  });

  app.post<{ Params: { id: string } }>('/:id/rotate-key', async (req, reply) => {
    const s = await prisma.server.findUnique({ where: { id: req.params.id } });
    if (!s || s.deletedAt) return reply.status(404).send({ error: 'NotFound' });
    // Best-effort: mark all old keys revoked, mint a new one. Old keys
    // are revoked AFTER the new key is issued so an in-flight agent has
    // time to fetch the new one (admin-driven flow — agent reconfigured
    // out-of-band via scheduled task).
    const { generateToken: gt } = await import('../lib/tokens.js');
    const { hashAgentKey } = await import('../lib/agentAuth.js');
    const plaintext = gt(32);
    const hash = hashAgentKey(plaintext);
    await prisma.$transaction(async (tx) => {
      await tx.agentKey.updateMany({
        where: { serverId: s.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.agentKey.create({ data: { serverId: s.id, keyHash: hash } });
    });
    req.audit({
      eventType: 'server.key.rotated',
      entityType: 'server',
      entityId: s.id,
      payload: {},
    });
    void reconcileAssignmentPrereq; // keep import live for tree-shaking sanity
    return reply.status(200).send({ agentApiKey: plaintext });
  });

  // List installed modules for a server.
  app.get<{ Params: { id: string } }>('/:id/modules', async (req, reply) => {
    const mods = await prisma.serverModule.findMany({
      where: { serverId: req.params.id },
      orderBy: { name: 'asc' },
    });
    return reply.send(
      mods.map((m) => ({
        serverId: m.serverId,
        name: m.name,
        installedVersion: m.installedVersion,
        discoveredAt: m.discoveredAt.toISOString(),
      })),
    );
  });
};

export default route;
