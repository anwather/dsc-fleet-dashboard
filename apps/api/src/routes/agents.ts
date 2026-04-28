/**
 * Agent-facing API. All routes except /register require Bearer = agent_api_key.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { loadEnv } from '../lib/env.js';
import { authenticateAgent, hashAgentKey } from '../lib/agentAuth.js';
import { generateToken } from '../lib/tokens.js';
import { strongEtag, normalizeEtag } from '../lib/etag.js';
import { reconcileAssignmentPrereq } from '../services/scheduler.js';
import { decrypt } from '../lib/runasCrypto.js';

const RegisterBody = z.object({
  provisionToken: z.string().min(1),
  hostname: z.string().min(1),
  osCaption: z.string().optional(),
  osVersion: z.string().optional(),
  agentVersion: z.string().optional(),
});

const HeartbeatBody = z.object({
  osCaption: z.string().nullish(),
  osVersion: z.string().nullish(),
  dscExeVersion: z.string().nullish(),
  agentVersion: z.string().nullish(),
  modules: z
    .array(z.object({ name: z.string(), version: z.string() }))
    .nullish()
    .transform((v) => v ?? []),
  serverTime: z.string().datetime().nullish(),
});

const ResultsBody = z.object({
  assignmentId: z.string().uuid(),
  generation: z.number().int().nonnegative(),
  runId: z.string().uuid(),
  revisionId: z.string().uuid(),
  exitCode: z.number().int(),
  hadErrors: z.boolean(),
  inDesiredState: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  dscOutput: z.unknown().optional(),
});

const RemovalAckBody = z.object({
  assignmentId: z.string().uuid(),
  generation: z.number().int().nonnegative(),
  success: z.boolean(),
  message: z.string().optional(),
});

interface RequiredModule {
  name: string;
  minVersion?: string;
}

const route: FastifyPluginAsync = async (app) => {
  // -------------------------------------------------------------------------
  // POST /register — provision-token gated, returns plaintext key once.
  // -------------------------------------------------------------------------
  app.post('/register', async (req, reply) => {
    const body = RegisterBody.parse(req.body);

    // Find the provision job that issued this token (Postgres JSONB filter on payload->>'token').
    // We accept queued/running/failed jobs — the token is the credential; even if the cloud-init
    // RunCommand failed (e.g. Azure unconfigured in dev), an out-of-band agent install may still
    // present a valid, unexpired token.
    const rows = await prisma.$queryRaw<Array<{ id: string; server_id: string; expires_at: string | null }>>`
      SELECT j.id, j.server_id, (j.payload->>'expiresAt') AS expires_at
      FROM jobs j
      WHERE j.type = 'provision'
        AND j.status IN ('queued','running','failed')
        AND j.payload->>'token' = ${body.provisionToken}
      ORDER BY j.requested_at DESC
      LIMIT 1
    `;
    const job = rows[0];

    if (!job) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'invalid provision token' });
    }
    if (job.expires_at && new Date(job.expires_at).getTime() < Date.now()) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'provision token expired' });
    }

    const server = await prisma.server.findUnique({ where: { id: job.server_id } });
    if (!server || server.deletedAt) {
      return reply.status(404).send({ error: 'NotFound', message: 'server unknown or deleted' });
    }

    const plaintextKey = generateToken(32);
    const keyHash = hashAgentKey(plaintextKey);

    const updated = await prisma.$transaction(async (tx) => {
      await tx.agentKey.create({ data: { serverId: server.id, keyHash } });
      const u = await tx.server.update({
        where: { id: server.id },
        data: {
          status: 'ready',
          hostname: body.hostname,
          osCaption: body.osCaption ?? server.osCaption,
          osVersion: body.osVersion ?? server.osVersion,
        },
      });
      await tx.job.update({
        where: { id: job.id },
        data: { status: 'success', finishedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: {
          eventType: 'agent.registered',
          entityType: 'server',
          entityId: server.id,
          actorType: 'agent',
          actorId: `agent:${u.agentId}`,
          payload: { hostname: body.hostname, agentVersion: body.agentVersion },
        },
      });
      return u;
    });

    app.broadcast(`server:${updated.id}`, 'status', { status: 'ready' });
    return reply.status(200).send({
      agentId: updated.agentId,
      agentApiKey: plaintextKey,
    });
  });

  // -------------------------------------------------------------------------
  // GET /:agentId/assignments?since=<etag>
  // -------------------------------------------------------------------------
  app.get<{ Params: { agentId: string }; Querystring: { since?: string } }>(
    '/:agentId/assignments',
    { preHandler: authenticateAgent },
    async (req, reply) => {
      const env = loadEnv();
      const server = req.dscServer!;
      const assignments = await prisma.assignment.findMany({
        where: {
          serverId: server.id,
          lifecycleState: { in: ['active', 'removing'] },
        },
        include: {
          config: { include: { currentRevision: true } },
          pinnedRevision: true,
        },
      });

      // Lazy-backfill: pin any active assignment that has no pinnedRevisionId
      // to the config's current revision. This prevents existing pre-pin
      // assignments from auto-upgrading when a new config revision is
      // published. After this runs once, subsequent revision publishes only
      // roll out via an explicit PATCH /assignments/:id from the UI.
      for (const a of assignments) {
        if (
          a.lifecycleState === 'active' &&
          !a.pinnedRevisionId &&
          a.config.currentRevisionId
        ) {
          await prisma.assignment.update({
            where: { id: a.id },
            data: { pinnedRevisionId: a.config.currentRevisionId },
          });
          a.pinnedRevisionId = a.config.currentRevisionId;
          a.pinnedRevision = a.config.currentRevision;
        }
      }

      const items = assignments.map((a) => {
        const rev = a.pinnedRevision ?? a.config.currentRevision;
        return {
          assignmentId: a.id,
          generation: a.generation,
          configId: a.configId,
          revisionId: rev?.id ?? null,
          version: rev?.version ?? null,
          sourceSha256: rev?.sourceSha256 ?? null,
          intervalMinutes: a.intervalMinutes,
          lifecycleState: a.lifecycleState,
          prereqStatus: a.prereqStatus,
          nextDueAt: a.nextDueAt?.toISOString() ?? null,
          requiredModules: rev?.requiredModules ?? [],
        };
      });

      // ETag on the deterministic essence — exclude server_time so 304s work.
      const digest = strongEtag(
        items
          .map((i) => [
            i.assignmentId,
            i.generation,
            i.revisionId,
            i.sourceSha256,
            i.intervalMinutes,
            i.lifecycleState,
            i.prereqStatus,
            i.nextDueAt,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );

      const sinceHeader = req.headers['if-none-match'];
      const sinceQuery = req.query.since;
      const since = normalizeEtag(typeof sinceHeader === 'string' ? sinceHeader : null) ?? normalizeEtag(sinceQuery);
      reply.header('ETag', digest);
      reply.header('Cache-Control', 'no-cache');

      if (since && since === digest) {
        return reply.status(304).send();
      }

      return reply.status(200).send({
        etag: digest,
        serverTime: new Date().toISOString(),
        pollIntervalSeconds: env.AGENT_POLL_DEFAULT_SECONDS,
        assignments: items.map((i) => ({ ...i, serverTime: new Date().toISOString() })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /:agentId/revisions/:revId
  // -------------------------------------------------------------------------
  app.get<{ Params: { agentId: string; revId: string } }>(
    '/:agentId/revisions/:revId',
    { preHandler: authenticateAgent },
    async (req, reply) => {
      const rev = await prisma.configRevision.findUnique({
        where: { id: req.params.revId },
      });
      if (!rev) {
        return reply.status(404).send({ error: 'NotFound', message: 'revision not found' });
      }
      // Ensure this revision is referenced by an assignment on this server (don't
      // expose arbitrary revisions across servers).
      const refd = await prisma.assignment.findFirst({
        where: {
          serverId: req.dscServer!.id,
          OR: [
            { pinnedRevisionId: rev.id },
            { config: { currentRevisionId: rev.id } },
          ],
        },
      });
      if (!refd) {
        return reply.status(404).send({ error: 'NotFound', message: 'revision not assigned to this server' });
      }
      return reply.status(200).send({
        revisionId: rev.id,
        configId: rev.configId,
        version: rev.version,
        yamlBody: rev.yamlBody,
        sourceSha256: rev.sourceSha256,
        requiredModules: rev.requiredModules,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /:agentId/results — idempotent on runId.
  // -------------------------------------------------------------------------
  app.post<{ Params: { agentId: string } }>(
    '/:agentId/results',
    { preHandler: authenticateAgent },
    async (req, reply) => {
      const body = ResultsBody.parse(req.body);
      const server = req.dscServer!;

      // Idempotency: same runId returns the existing row.
      const existing = await prisma.runResult.findFirst({ where: { runId: body.runId } });
      if (existing) {
        return reply.status(200).send({ runResultId: existing.id, idempotent: true });
      }

      const assignment = await prisma.assignment.findUnique({ where: { id: body.assignmentId } });
      if (!assignment || assignment.serverId !== server.id) {
        return reply.status(404).send({ error: 'NotFound', message: 'assignment not on this server' });
      }
      if (assignment.generation !== body.generation) {
        return reply.status(409).send({
          error: 'GenerationMismatch',
          expected: assignment.generation,
          got: body.generation,
        });
      }

      const finishedAt = new Date(body.finishedAt);
      const startedAt = new Date(body.startedAt);
      const lastStatus = body.exitCode !== 0 || body.hadErrors
        ? 'error'
        : body.inDesiredState
        ? 'success'
        : 'drift';

      const result = await prisma.$transaction(async (tx) => {
        const rr = await tx.runResult.create({
          data: {
            assignmentId: assignment.id,
            serverId: server.id,
            configRevisionId: body.revisionId,
            generation: body.generation,
            runId: body.runId,
            exitCode: body.exitCode,
            hadErrors: body.hadErrors,
            inDesiredState: body.inDesiredState,
            durationMs: body.durationMs,
            dscOutput: (body.dscOutput ?? {}) as object,
            startedAt,
            finishedAt,
          },
        });
        await tx.assignment.update({
          where: { id: assignment.id },
          data: {
            lastRunAt: finishedAt,
            lastStatus,
            lastExitCode: body.exitCode,
            lastSuccessAt: lastStatus === 'success' ? finishedAt : assignment.lastSuccessAt,
            lastFailureAt: lastStatus === 'error' ? finishedAt : assignment.lastFailureAt,
            nextDueAt: new Date(finishedAt.getTime() + assignment.intervalMinutes * 60_000),
          },
        });
        await tx.auditEvent.create({
          data: {
            eventType: 'agent.run.posted',
            entityType: 'assignment',
            entityId: assignment.id,
            actorType: 'agent',
            actorId: `agent:${server.agentId}`,
            payload: {
              runId: body.runId,
              exitCode: body.exitCode,
              lastStatus,
              durationMs: body.durationMs,
            },
          },
        });
        return rr;
      });

      app.broadcast(`server:${server.id}`, 'run.posted', {
        assignmentId: assignment.id,
        runResultId: result.id,
        lastStatus,
      });

      return reply.status(200).send({ runResultId: result.id, lastStatus });
    },
  );

  // -------------------------------------------------------------------------
  // POST /:agentId/heartbeat
  // -------------------------------------------------------------------------
  app.post<{ Params: { agentId: string } }>(
    '/:agentId/heartbeat',
    { preHandler: authenticateAgent },
    async (req, reply) => {
      const env = loadEnv();
      const body = HeartbeatBody.parse(req.body);
      const server = req.dscServer!;
      const now = new Date();

      await prisma.$transaction(async (tx) => {
        await tx.server.update({
          where: { id: server.id },
          data: {
            lastHeartbeatAt: now,
            osCaption: body.osCaption ?? server.osCaption,
            osVersion: body.osVersion ?? server.osVersion,
            // Once we've heard from the agent and it isn't in the middle of provisioning, ready.
            status: server.status === 'offline' || server.status === 'pending' ? 'ready' : server.status,
          },
        });
        // Upsert reported modules.
        for (const m of body.modules) {
          await tx.serverModule.upsert({
            where: { serverId_name: { serverId: server.id, name: m.name } },
            create: {
              serverId: server.id,
              name: m.name,
              installedVersion: m.version,
              discoveredAt: now,
            },
            update: { installedVersion: m.version, discoveredAt: now },
          });
        }
      });

      // Reconcile prereq for every assignment of this server.
      const active = await prisma.assignment.findMany({
        where: { serverId: server.id, lifecycleState: 'active' },
        select: { id: true },
      });
      for (const a of active) await reconcileAssignmentPrereq(a.id);

      app.broadcast(`server:${server.id}`, 'heartbeat', { ts: now.toISOString() });

      return reply.status(200).send({
        serverTime: now.toISOString(),
        pollIntervalSeconds: env.AGENT_POLL_DEFAULT_SECONDS,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /:agentId/removal-ack
  // -------------------------------------------------------------------------
  app.post<{ Params: { agentId: string } }>(
    '/:agentId/removal-ack',
    { preHandler: authenticateAgent },
    async (req, reply) => {
      const body = RemovalAckBody.parse(req.body);
      const server = req.dscServer!;
      const a = await prisma.assignment.findUnique({ where: { id: body.assignmentId } });
      if (!a || a.serverId !== server.id) {
        return reply.status(404).send({ error: 'NotFound', message: 'assignment not on this server' });
      }
      if (a.lifecycleState !== 'removing') {
        return reply.status(409).send({
          error: 'Conflict',
          message: `cannot ack removal in state ${a.lifecycleState}`,
        });
      }
      const now = new Date();
      await prisma.$transaction(async (tx) => {
        await tx.assignment.update({
          where: { id: a.id },
          data: {
            lifecycleState: 'removed',
            removalAckAt: now,
            removedAt: now,
          },
        });
        await tx.auditEvent.create({
          data: {
            eventType: body.success ? 'agent.removal.success' : 'agent.removal.failed',
            entityType: 'assignment',
            entityId: a.id,
            actorType: 'agent',
            actorId: `agent:${server.agentId}`,
            payload: { success: body.success, message: body.message ?? null },
          },
        });
      });
      app.broadcast(`server:${server.id}`, 'assignment.removed', {
        assignmentId: a.id,
        success: body.success,
      });
      logger.debug({ assignmentId: a.id, success: body.success }, 'removal acked');
      return reply.status(200).send({ ok: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /runas/:urlToken — one-time run-as credential drop.
  //
  // Auth: `Authorization: Bearer <provisionToken>`. The provisionToken must
  // match the value stored in the credential row when it was issued. Single
  // use enforced by an atomic UPDATE setting consumed_at.
  //
  // Response: { username, kind, password? }. password is omitted for gMSA.
  //
  // Side effects: ciphertext / iv / auth_tag are zeroed on the row after
  // successful read so a later DB compromise can't recover the password.
  // -------------------------------------------------------------------------
  app.post<{ Params: { urlToken: string } }>('/runas/:urlToken', async (req, reply) => {
    const auth = req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Bearer token required' });
    }
    const provisionToken = auth.slice(7).trim();
    if (!provisionToken) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Empty bearer token' });
    }

    const urlToken = req.params.urlToken;
    if (!urlToken || urlToken.length < 16) {
      return reply.status(400).send({ error: 'BadRequest', message: 'invalid url token' });
    }

    // Atomic single-use: set consumed_at only if currently null, not expired,
    // and provisionToken matches. Postgres UPDATE...RETURNING is atomic.
    const now = new Date();
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        server_id: string;
        username: string;
        kind: string;
        iv: Buffer;
        ciphertext: Buffer;
        auth_tag: Buffer;
      }>
    >`
      UPDATE agent_credentials
      SET consumed_at = ${now}
      WHERE url_token = ${urlToken}
        AND consumed_at IS NULL
        AND expires_at > ${now}
        AND provision_token = ${provisionToken}
      RETURNING id, server_id, username, kind, iv, ciphertext, auth_tag
    `;
    const row = rows[0];
    if (!row) {
      // Could be: bad urlToken, already consumed, expired, or provisionToken
      // mismatch. Don't disclose which.
      return reply
        .status(401)
        .send({ error: 'Unauthorized', message: 'credential unavailable' });
    }

    let password: string | undefined;
    if (row.kind === 'password') {
      try {
        password = decrypt({
          iv: Buffer.from(row.iv),
          ciphertext: Buffer.from(row.ciphertext),
          authTag: Buffer.from(row.auth_tag),
        });
      } catch (err) {
        logger.error({ err, credentialId: row.id }, 'failed to decrypt run-as credential');
        return reply
          .status(500)
          .send({ error: 'InternalError', message: 'decrypt failed' });
      }
    }

    // Scrub ciphertext immediately. The row is kept (consumed_at audit) but
    // the encrypted material is no longer recoverable.
    const empty = Buffer.alloc(0);
    await prisma.agentCredential.update({
      where: { id: row.id },
      data: { iv: empty, ciphertext: empty, authTag: empty },
    });

    await prisma.auditEvent.create({
      data: {
        eventType: 'runas.credential.consumed',
        entityType: 'server',
        entityId: row.server_id,
        actorType: 'agent',
        actorId: null,
        payload: { kind: row.kind, user: row.username },
      },
    });

    const body: { username: string; kind: string; password?: string } = {
      username: row.username,
      kind: row.kind,
    };
    if (password !== undefined) body.password = password;
    return reply.status(200).send(body);
  });
};

export default route;
