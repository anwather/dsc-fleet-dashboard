import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma.js';

interface JobLite {
  id: string;
  serverId: string | null;
  type: string;
  status: string;
  payload: unknown;
  log: string | null;
  attempts: number;
  errorCode: string | null;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

function shape(j: JobLite, includeLog = true) {
  return {
    id: j.id,
    serverId: j.serverId,
    type: j.type,
    status: j.status,
    payload: j.payload,
    log: includeLog ? j.log : null,
    attempts: j.attempts,
    errorCode: j.errorCode,
    requestedAt: j.requestedAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
  };
}

const route: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { serverId?: string; status?: string; type?: string; take?: string } }>(
    '/',
    async (req, reply) => {
      const where: Record<string, unknown> = {};
      if (req.query.serverId) where.serverId = req.query.serverId;
      if (req.query.status) where.status = req.query.status;
      if (req.query.type) where.type = req.query.type;
      const take = Math.min(Number.parseInt(req.query.take ?? '50', 10) || 50, 200);
      const rows = await prisma.job.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        take,
      });
      // Include the log on list responses too — the UI's JobCard renders
      // job.log inline so the user can see provisioning output without
      // drilling into the per-job detail endpoint. List is capped at 200,
      // and individual logs are small (~10-50KB), so this is fine.
      return reply.send(rows.map((r) => shape(r, true)));
    },
  );

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const j = await prisma.job.findUnique({ where: { id: req.params.id } });
    if (!j) return reply.status(404).send({ error: 'NotFound' });
    return reply.send(shape(j, true));
  });

  // Plain-text log endpoint for tail-style polling.
  app.get<{ Params: { id: string } }>('/:id/log', async (req, reply) => {
    const j = await prisma.job.findUnique({
      where: { id: req.params.id },
      select: { log: true },
    });
    if (!j) return reply.status(404).send({ error: 'NotFound' });
    reply.header('content-type', 'text/plain; charset=utf-8');
    return reply.send(j.log ?? '');
  });
};

export default route;
