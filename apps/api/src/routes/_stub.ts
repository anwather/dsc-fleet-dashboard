/**
 * Helper for stub routes that return a uniform 501 Not Implemented response.
 * Routes are wired up so the surface area is locked in early; bodies will
 * land in subsequent Phase 2 todos (6+).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export function notImplemented(name: string) {
  return async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(501).send({
      error: 'NotImplemented',
      message: `${name} is not implemented yet`,
    });
  };
}
