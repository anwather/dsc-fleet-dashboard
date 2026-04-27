import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getAzureCredentialStatus } from '../services/azureCompute.js';

const HealthResponse = z.object({
  status: z.literal('ok').or(z.literal('degraded')),
  db: z.literal('ok').or(z.literal('error')),
  azure: z.enum(['ok', 'unconfigured', 'error']),
  azureError: z.string().nullable().optional(),
  uptimeSeconds: z.number(),
});

const startedAt = Date.now();

const route: FastifyPluginAsync = async (app) => {
  app.get(
    '/healthz',
    { schema: { response: { 200: HealthResponse, 503: HealthResponse } } },
    async (_req, reply) => {
      let dbOk = true;
      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch (err) {
        dbOk = false;
        app.log.error({ err }, 'healthz: db check failed');
      }
      const azure = getAzureCredentialStatus();
      const status = dbOk ? 'ok' : 'degraded';
      const body = {
        status,
        db: dbOk ? 'ok' : 'error',
        azure: azure.status,
        azureError: azure.error,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      } as const;
      return reply.status(dbOk ? 200 : 503).send(body);
    },
  );
};

export default route;
