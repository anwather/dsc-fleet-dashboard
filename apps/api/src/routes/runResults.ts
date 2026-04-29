import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma.js';

const route: FastifyPluginAsync = async (app) => {
  app.get<{
    Querystring: {
      serverId?: string;
      assignmentId?: string;
      take?: string;
    };
  }>('/', async (req, reply) => {
    const where: Record<string, unknown> = {};
    if (req.query.serverId) where.serverId = req.query.serverId;
    if (req.query.assignmentId) where.assignmentId = req.query.assignmentId;
    const take = Math.min(Number.parseInt(req.query.take ?? '100', 10) || 100, 500);
    const rows = await prisma.runResult.findMany({
      where,
      orderBy: { finishedAt: 'desc' },
      take,
    });
    return reply.send(
      rows.map((r) => ({
        id: r.id,
        assignmentId: r.assignmentId,
        serverId: r.serverId,
        configRevisionId: r.configRevisionId,
        generation: r.generation,
        runId: r.runId,
        exitCode: r.exitCode,
        hadErrors: r.hadErrors,
        inDesiredState: r.inDesiredState,
        durationMs: r.durationMs,
        dscOutput: r.dscOutput,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt.toISOString(),
      })),
    );
  });

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const r = await prisma.runResult.findUnique({ where: { id: req.params.id } });
    if (!r) return reply.status(404).send({ error: 'NotFound' });
    return reply.send({
      id: r.id,
      assignmentId: r.assignmentId,
      serverId: r.serverId,
      configRevisionId: r.configRevisionId,
      generation: r.generation,
      runId: r.runId,
      exitCode: r.exitCode,
      hadErrors: r.hadErrors,
      inDesiredState: r.inDesiredState,
      durationMs: r.durationMs,
      dscOutput: r.dscOutput,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt.toISOString(),
    });
  });
};

export default route;
