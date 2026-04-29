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
import { startScheduler } from './services/scheduler.js';
import { bindJobsApp } from './services/jobs.js';

import errorHandlerPlugin from './plugins/errorHandler.js';
import auditPlugin from './plugins/audit.js';
import websocketPlugin from './plugins/websocket.js';
import entraAuthPlugin from './plugins/entraAuth.js';

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
  await app.register(entraAuthPlugin);
  await app.register(websocketPlugin);

  // Anonymous: health probes.
  await app.register(healthRoutes);

  // Entra-protected dashboard routes (browser/human traffic).
  // NOTE: Fastify `register()` does NOT accept `preHandler` as a register
  // option — hooks must be installed via addHook inside an encapsulated
  // scope. Wrap the protected routes in a child plugin that registers
  // the preHandler hook for everything inside it.
  await app.register(async (protectedScope) => {
    protectedScope.addHook('preHandler', app.entraPreHandler);
    await protectedScope.register(serversRoutes,     { prefix: '/api/servers' });
    await protectedScope.register(configsRoutes,     { prefix: '/api/configs' });
    await protectedScope.register(assignmentsRoutes, { prefix: '/api/assignments' });
    await protectedScope.register(jobsRoutes,        { prefix: '/api/jobs' });
    await protectedScope.register(runResultsRoutes,  { prefix: '/api/run-results' });
    await protectedScope.register(auditEventsRoutes, { prefix: '/api/audit-events' });
  });

  // Agent + RunAs: their own bearer-key / URL-token auth, no Entra.
  await app.register(agentsRoutes,      { prefix: '/api/agents' });

  return { app, env };
}

async function main() {
  const { app, env } = await buildApp();

  await initAzureCredential();
  bindJobsApp(app);
  startScheduler(app);

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
