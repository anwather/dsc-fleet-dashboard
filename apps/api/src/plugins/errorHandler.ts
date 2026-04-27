/**
 * Centralised error handler.
 *
 * Maps:
 *  - Zod errors                                     → 400 with field-level issues
 *  - Prisma known request errors (P2002, P2025, …) → 409 / 404 / 400
 *  - Anything else                                  → 500 with safe message
 */
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

const errorHandlerPlugin: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((err, req, reply) => {
    // Validation errors from @fastify/type-provider-zod
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Request failed schema validation',
        issues: err.validation,
      });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'ValidationError',
        message: 'Validation failed',
        issues: err.issues,
      });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      switch (err.code) {
        case 'P2002':
          return reply.status(409).send({
            error: 'Conflict',
            message: 'Unique constraint violation',
            target: err.meta?.target,
          });
        case 'P2025':
          return reply
            .status(404)
            .send({ error: 'NotFound', message: 'Record not found' });
        case 'P2003':
          return reply.status(400).send({
            error: 'BadRequest',
            message: 'Foreign key constraint failed',
            target: err.meta?.target,
          });
        default:
          req.log.error({ err }, 'unhandled prisma error');
          return reply.status(500).send({
            error: 'PrismaError',
            code: err.code,
            message: err.message,
          });
      }
    }
    if (err instanceof Prisma.PrismaClientValidationError) {
      return reply
        .status(400)
        .send({ error: 'ValidationError', message: err.message });
    }

    // Honour any explicit statusCode set by routes (e.g. fastify.httpErrors)
    const fallback = err as Error & { statusCode?: number };
    const status = fallback.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err: fallback }, 'unhandled error');
    }
    return reply.status(status).send({
      error: fallback.name || 'InternalServerError',
      message: status >= 500 ? 'Internal server error' : fallback.message,
    });
  });
};

export default fp(errorHandlerPlugin, { name: 'error-handler' });
