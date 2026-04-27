import type { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma.js';

const route: FastifyPluginAsync = async (app) => {
  app.get<{
    Querystring: {
      entityType?: string;
      entityId?: string;
      eventType?: string;
      actorType?: string;
      take?: string;
    };
  }>('/', async (req, reply) => {
    const where: Record<string, unknown> = {};
    if (req.query.entityType) where.entityType = req.query.entityType;
    if (req.query.entityId) where.entityId = req.query.entityId;
    if (req.query.eventType) where.eventType = req.query.eventType;
    if (req.query.actorType) where.actorType = req.query.actorType;
    const take = Math.min(Number.parseInt(req.query.take ?? '200', 10) || 200, 1000);
    const rows = await prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
    });
    return reply.send(
      rows.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        entityType: e.entityType,
        entityId: e.entityId,
        actorType: e.actorType,
        actorId: e.actorId,
        payload: e.payload,
        createdAt: e.createdAt.toISOString(),
      })),
    );
  });
};

export default route;
