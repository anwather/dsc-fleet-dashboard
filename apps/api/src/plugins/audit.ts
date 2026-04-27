/**
 * Audit-events plugin.
 *
 * Decorates the Fastify request with `req.audit(eventType, payload)`.
 * Routes call this for every UI-facing mutation; the plugin's `onResponse`
 * hook flushes any queued events into `audit_events` after a successful
 * (2xx) response. Failures are logged but never break the request.
 *
 * Convention:
 *   req.audit('server.created', { entityType: 'server', entityId, payload })
 */
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ActorType } from '@dsc-fleet/shared-types';
import { prisma } from '../lib/prisma.js';

export interface PendingAuditEvent {
  eventType: string;
  entityType: string;
  entityId?: string | null;
  actorType?: ActorType;
  actorId?: string | null;
  payload?: Record<string, unknown>;
}

declare module 'fastify' {
  interface FastifyRequest {
    audit(event: PendingAuditEvent): void;
    _pendingAudits: PendingAuditEvent[];
  }
}

const noopAudit = function (this: FastifyRequest, _e: PendingAuditEvent) {
  // placeholder — replaced per-request in onRequest
};

const auditPlugin: FastifyPluginAsync = async (app) => {
  // Fastify 5: decorate with `null` placeholder; per-request value is assigned
  // in the onRequest hook below. (Reference defaults are forbidden.)
  app.decorateRequest('_pendingAudits', null as unknown as PendingAuditEvent[]);
  app.decorateRequest('audit', noopAudit);

  app.addHook('onRequest', async (req) => {
    req._pendingAudits = [];
    req.audit = (event: PendingAuditEvent) => {
      req._pendingAudits.push(event);
    };
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!req._pendingAudits || req._pendingAudits.length === 0) return;
    if (reply.statusCode >= 400) return; // don't audit failures
    const events = req._pendingAudits;
    req._pendingAudits = [];
    try {
      await prisma.auditEvent.createMany({
        data: events.map((e) => ({
          eventType: e.eventType,
          entityType: e.entityType,
          entityId: e.entityId ?? null,
          actorType: e.actorType ?? 'ui',
          actorId: e.actorId ?? null,
          payload: (e.payload ?? {}) as object,
        })),
      });
    } catch (err) {
      req.log.error({ err }, 'failed to persist audit events');
    }
  });
};

export default fp(auditPlugin, { name: 'audit' });
