/**
 * Fastify plugin that exposes `app.entraPreHandler` for dashboard routes
 * to opt in to Entra (Azure AD) bearer-token enforcement.
 *
 * Apply per-route or per-router via:
 *   await app.register(serversRoutes, { prefix: '/api/servers', preHandler: app.entraPreHandler });
 *
 * On success decorates `req.entraUser`. On failure responds 401 with a small
 * JSON body (no claim leakage).
 */
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { verifyEntraJwt, type EntraUser } from '../lib/entraAuth.js';

declare module 'fastify' {
  interface FastifyInstance {
    entraPreHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    entraUser?: EntraUser;
  }
}

const entraAuthPlugin: FastifyPluginAsync = async (app) => {
  app.decorate(
    'entraPreHandler',
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const auth = req.headers['authorization'];
      if (typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Bearer token required' });
      }
      const token = auth.slice(7).trim();
      if (!token) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Empty bearer token' });
      }
      try {
        req.entraUser = await verifyEntraJwt(token);
      } catch (err) {
        const reason = (err as Error).message;
        // Internal dashboard — surface the real reason in logs at WARN so it
        // appears in `az containerapp logs show` without flipping log level,
        // and echo a short code to the client so the user can tell the
        // difference between "wrong audience" / "missing scope" / "wrong
        // tenant" without grepping logs.
        req.log.warn({ reason }, 'entra token rejected');
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid token',
          reason,
        });
      }
    },
  );
};

export default fp(entraAuthPlugin, { name: 'entraAuth' });
