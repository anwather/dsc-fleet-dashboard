/**
 * Fastify server entrypoint.
 *
 * Boot order:
 *   1. Load env (validates required vars).
 *   2. Probe Azure credentials (non-fatal — surfaces in /healthz).
 *   3. Register plugins (error handler, audit, websocket).
 *   4. Register routes.
 *   5. Listen on API_PORT.
 */
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import { loadEnv } from './lib/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { initAzureCredential } from './services/azureCompute.js';

import errorHandlerPlugin from './plugins/errorHandler.js';
import auditPlugin from './plugins/audit.js';
import websocketPlugin from './plugins/websocket.js';

import healthRoutes from './routes/health.js';
import serversRoutes from './routes/servers.js';
import configsRoutes from './routes/configs.js';
import assignmentsRoutes from './routes/assignments.js';
import jobsRoutes from './routes/jobs.js';
import runResultsRoutes from './routes/runResults.js';
import auditEventsRoutes from './routes/auditEvents.js';
import agentsRoutes from './routes/agents.js';

async function buildApp() {
  const env = loadEnv();

  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
    bodyLimit: 10 * 1024 * 1024, // 10 MB — generous for YAML uploads
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errorHandlerPlugin);
  await app.register(auditPlugin);
  await app.register(websocketPlugin);

  await app.register(healthRoutes);
  await app.register(serversRoutes,     { prefix: '/api/servers' });
  await app.register(configsRoutes,     { prefix: '/api/configs' });
  await app.register(assignmentsRoutes, { prefix: '/api/assignments' });
  await app.register(jobsRoutes,        { prefix: '/api/jobs' });
  await app.register(runResultsRoutes,  { prefix: '/api/run-results' });
  await app.register(auditEventsRoutes, { prefix: '/api/audit-events' });
  await app.register(agentsRoutes,      { prefix: '/api/agents' });

  return { app, env };
}

async function main() {
  const { app, env } = await buildApp();

  await initAzureCredential();

  const close = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));

  try {
    await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  } catch (err) {
    logger.fatal({ err }, 'failed to start server');
    process.exit(1);
  }
}

main();
