/**
 * UI-facing /api/configs routes — CRUD over Config + ConfigRevision.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { parseConfigYaml } from '../services/yamlParser.js';

const ConfigCreate = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  yamlBody: z.string().min(1),
});

const ConfigUpdate = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  yamlBody: z.string().min(1).optional(),
});

const ParseBody = z.object({ yamlBody: z.string().min(1) });

interface RevisionLite {
  id: string;
  configId: string;
  version: number;
  sourceSha256: string;
  semanticSha256: string;
  requiredModules: unknown;
  parsedResources: unknown;
  createdAt: Date;
}

function shapeRevision(r: RevisionLite) {
  return {
    id: r.id,
    configId: r.configId,
    version: r.version,
    sourceSha256: r.sourceSha256,
    semanticSha256: r.semanticSha256,
    requiredModules: r.requiredModules,
    parsedResources: r.parsedResources,
    createdAt: r.createdAt.toISOString(),
  };
}

const route: FastifyPluginAsync = async (app) => {
  app.get('/', async (_req, reply) => {
    const rows = await prisma.config.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        currentRevision: true,
        _count: {
          select: {
            assignments: {
              where: {
                lifecycleState: { in: ['active', 'removing'] },
                server: { deletedAt: null },
              },
            },
          },
        },
      },
    });
    return reply.send(
      rows.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        currentRevision: c.currentRevision ? shapeRevision(c.currentRevision) : null,
        assignmentCount: c._count.assignments,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
    );
  });

  app.post('/', async (req, reply) => {
    const body = ConfigCreate.parse(req.body);
    const parsed = await parseConfigYaml(body.yamlBody);
    if (parsed.errors.length > 0) {
      return reply.status(400).send({
        error: 'YamlInvalid',
        message: 'YAML failed parse/schema validation',
        issues: parsed.errors,
        warnings: parsed.warnings,
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const c = await tx.config.create({
        data: { name: body.name, description: body.description ?? null },
      });
      const rev = await tx.configRevision.create({
        data: {
          configId: c.id,
          version: 1,
          yamlBody: body.yamlBody,
          sourceSha256: parsed.sourceSha256,
          semanticSha256: parsed.semanticSha256,
          requiredModules: parsed.requiredModules as unknown as Prisma.InputJsonValue,
          parsedResources: parsed.parsedResources as unknown as Prisma.InputJsonValue,
        },
      });
      const updated = await tx.config.update({
        where: { id: c.id },
        data: { currentRevisionId: rev.id },
        include: { currentRevision: true },
      });
      return updated;
    });

    req.audit({
      eventType: 'config.created',
      entityType: 'config',
      entityId: result.id,
      payload: { name: result.name },
    });

    return reply.status(201).send({
      id: result.id,
      name: result.name,
      description: result.description,
      currentRevision: result.currentRevision ? shapeRevision(result.currentRevision) : null,
      createdAt: result.createdAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
    });
  });

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const c = await prisma.config.findUnique({
      where: { id: req.params.id },
      include: {
        currentRevision: true,
        _count: {
          select: {
            assignments: {
              where: {
                lifecycleState: { in: ['active', 'removing'] },
                server: { deletedAt: null },
              },
            },
          },
        },
      },
    });
    if (!c || c.deletedAt) return reply.status(404).send({ error: 'NotFound' });
    return reply.send({
      id: c.id,
      name: c.name,
      description: c.description,
      currentRevision: c.currentRevision ? shapeRevision(c.currentRevision) : null,
      assignmentCount: c._count.assignments,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    });
  });

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const body = ConfigUpdate.parse(req.body);
    const c = await prisma.config.findUnique({
      where: { id: req.params.id },
      include: { currentRevision: true },
    });
    if (!c || c.deletedAt) return reply.status(404).send({ error: 'NotFound' });

    let newRevId: string | null = null;
    let newRev: RevisionLite | null = null;

    if (body.yamlBody) {
      const parsed = await parseConfigYaml(body.yamlBody);
      if (parsed.errors.length > 0) {
        return reply.status(400).send({
          error: 'YamlInvalid',
          message: 'YAML failed parse/schema validation',
          issues: parsed.errors,
          warnings: parsed.warnings,
        });
      }
      // Suppress no-op edits using semanticSha256.
      if (
        c.currentRevision &&
        c.currentRevision.semanticSha256 === parsed.semanticSha256 &&
        c.currentRevision.sourceSha256 === parsed.sourceSha256
      ) {
        // identical body — skip new revision
      } else {
        const last = await prisma.configRevision.findFirst({
          where: { configId: c.id },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const nextVersion = (last?.version ?? 0) + 1;
        const created = await prisma.configRevision.create({
          data: {
            configId: c.id,
            version: nextVersion,
            yamlBody: body.yamlBody,
            sourceSha256: parsed.sourceSha256,
            semanticSha256: parsed.semanticSha256,
            requiredModules: parsed.requiredModules as unknown as Prisma.InputJsonValue,
            parsedResources: parsed.parsedResources as unknown as Prisma.InputJsonValue,
          },
        });
        newRevId = created.id;
        newRev = created;
      }
    }

    const updated = await prisma.config.update({
      where: { id: c.id },
      data: {
        name: body.name ?? c.name,
        description: body.description ?? c.description,
        ...(newRevId ? { currentRevisionId: newRevId } : {}),
      },
      include: { currentRevision: true },
    });

    // Bump generation on every active assignment of this config so the agent
    // re-applies on its next poll. We also clear nextDueAt → now.
    if (newRev) {
      const affected = await prisma.assignment.findMany({
        where: { configId: c.id, lifecycleState: 'active' },
      });
      for (const a of affected) {
        await prisma.assignment.update({
          where: { id: a.id },
          data: { generation: a.generation + 1, nextDueAt: new Date() },
        });
        app.broadcast(`server:${a.serverId}`, 'assignment.updated', {
          assignmentId: a.id,
          generation: a.generation + 1,
        });
      }
    }

    req.audit({
      eventType: 'config.updated',
      entityType: 'config',
      entityId: c.id,
      payload: {
        name: body.name,
        description: body.description,
        newRevision: newRev?.id ?? null,
      },
    });

    return reply.send({
      id: updated.id,
      name: updated.name,
      description: updated.description,
      currentRevision: updated.currentRevision ? shapeRevision(updated.currentRevision) : null,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const c = await prisma.config.findUnique({ where: { id: req.params.id } });
    if (!c || c.deletedAt) return reply.status(404).send({ error: 'NotFound' });
    const active = await prisma.assignment.count({
      where: {
        configId: c.id,
        lifecycleState: { in: ['active', 'removing'] },
        server: { deletedAt: null },
      },
    });
    if (active > 0) {
      return reply.status(409).send({
        error: 'Conflict',
        message: `cannot delete config with ${active} active/removing assignments`,
      });
    }
    await prisma.config.update({
      where: { id: c.id },
      data: { deletedAt: new Date() },
    });
    req.audit({
      eventType: 'config.deleted',
      entityType: 'config',
      entityId: c.id,
      payload: {},
    });
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/:id/revisions', async (req, reply) => {
    const revs = await prisma.configRevision.findMany({
      where: { configId: req.params.id },
      orderBy: { version: 'desc' },
    });
    return reply.send(revs.map(shapeRevision));
  });

  app.get<{ Params: { id: string; revId: string } }>(
    '/:id/revisions/:revId',
    async (req, reply) => {
      const r = await prisma.configRevision.findUnique({ where: { id: req.params.revId } });
      if (!r || r.configId !== req.params.id) {
        return reply.status(404).send({ error: 'NotFound' });
      }
      return reply.send({ ...shapeRevision(r), yamlBody: r.yamlBody });
    },
  );

  app.post('/parse', async (req, reply) => {
    const body = ParseBody.parse(req.body);
    const parsed = await parseConfigYaml(body.yamlBody);
    return reply.send(parsed);
  });
};

export default route;
